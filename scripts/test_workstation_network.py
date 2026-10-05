import unittest
import tempfile
import json
from pathlib import Path
from unittest.mock import patch

import requests
import workstation_pipeline as network


class FallbackTests(unittest.TestCase):
    def setUp(self):
        network.ROUTES.clear()
        network.COOLDOWNS.clear()
        self.request = requests.Request("GET", "https://example.com/file").prepare()

    def response(self, status):
        response = requests.Response()
        response.status_code = status
        response._content = b""
        response._content_consumed = True
        return response

    def test_saving_one_host_preserves_other_process_routes(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "routes.json"
            state.write_text(json.dumps({"other.com": "socks5h://other:1080"}))
            network.ROUTES["example.com"] = "socks5h://new:1080"
            with patch.object(network, "STATE", state):
                network.save_routes("example.com")
            self.assertEqual(json.loads(state.read_text()), {
                "other.com": "socks5h://other:1080", "example.com": "socks5h://new:1080"})

    def test_interrupted_bulk_object_does_not_redirect_unrelated_object(self):
        host = "cdn.gea.esac.esa.int"
        broken = self.response(200)
        def chunks(*args, **kwargs):
            raise requests.ConnectionError("truncated object")
            yield
        broken.iter_content = chunks
        first = requests.Request("GET", f"https://{host}/one.csv.gz").prepare()
        second = requests.Request("GET", f"https://{host}/two.csv.gz").prepare()
        with patch.object(network.HTTPAdapter, "send", side_effect=[broken, self.response(200)]) as send:
            response = network.FallbackAdapter().send(first, timeout=30, proxies={})
            with self.assertRaises(requests.ConnectionError):
                list(response.iter_content())
            network.FallbackAdapter().send(second, timeout=30, proxies={})
        self.assertEqual(send.call_args.kwargs["proxies"], {})

    def test_connection_failure_uses_remote_dns_proxy_and_remembers_host(self):
        with patch.object(network, "candidates", return_value=["socks5h://10.64.0.1:1080"]), \
             patch.object(network.HTTPAdapter, "send", side_effect=[requests.ConnectionError(), self.response(200)]) as send, \
             patch.object(network, "save_routes"):
            network.FallbackAdapter().send(self.request, timeout=180, proxies={})
        self.assertEqual(send.call_args.kwargs["proxies"]["https"], "socks5h://10.64.0.1:1080")
        self.assertEqual(send.call_args.kwargs["timeout"], (5, 180))
        self.assertEqual(network.ROUTES["example.com"], "socks5h://10.64.0.1:1080")

    def test_rate_limits_and_missing_files_do_not_rotate(self):
        for status in (429, 404):
            with patch.object(network.HTTPAdapter, "send", return_value=self.response(status)) as send:
                response = network.FallbackAdapter().send(self.request, timeout=30)
            self.assertEqual(response.status_code, status)
            self.assertEqual(send.call_count, 1)

    def test_gateway_error_rotates_to_another_route(self):
        with patch.object(network, "candidates", return_value=["socks5h://10.64.0.1:1080"]), \
             patch.object(network.HTTPAdapter, "send", side_effect=[self.response(504), self.response(200)]) as send, \
             patch.object(network, "save_routes"):
            response = network.FallbackAdapter().send(self.request, timeout=30, proxies={})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(send.call_count, 2)
        self.assertEqual(network.ROUTES["example.com"], "socks5h://10.64.0.1:1080")

    def test_cached_proxy_failure_returns_to_normal_route(self):
        network.ROUTES["example.com"] = "socks5h://dead:1080"
        with patch.object(network.HTTPAdapter, "send", side_effect=[requests.ConnectionError(), self.response(200)]) as send, \
             patch.object(network, "save_routes"):
            network.FallbackAdapter().send(self.request, timeout=30, proxies={})
        self.assertEqual(send.call_args.kwargs["proxies"], {})
        self.assertNotIn("example.com", network.ROUTES)

    def test_bulk_cdn_retries_normal_route_after_prior_proxy_success(self):
        host = "cdn.gea.esac.esa.int"
        network.ROUTES[host] = "socks5h://10.64.0.1:1080"
        request = requests.Request("GET", f"https://{host}/file.csv.gz").prepare()
        with patch.object(network.HTTPAdapter, "send", return_value=self.response(200)) as send:
            network.FallbackAdapter().send(request, timeout=30, proxies={})
        self.assertEqual(send.call_args.kwargs["proxies"], {})

    def test_bulk_cdn_normal_route_failure_still_uses_proxy(self):
        host = "cdn.gea.esac.esa.int"
        request = requests.Request("GET", f"https://{host}/file.csv.gz").prepare()
        with patch.object(network, "candidates", return_value=["socks5h://10.64.0.1:1080"]), \
             patch.object(network.HTTPAdapter, "send", side_effect=[requests.ConnectionError(), self.response(200)]) as send, \
             patch.object(network, "save_routes"):
            network.FallbackAdapter().send(request, timeout=30, proxies={})
        self.assertEqual(send.call_args.kwargs["proxies"]["https"], "socks5h://10.64.0.1:1080")

    def test_exhausted_primary_routes_discover_more_relays(self):
        with patch.object(network, "candidates", return_value=["socks5h://primary:1080"]), \
             patch.object(network, "relay_candidates", return_value=["socks5h://relay:1080"]), \
             patch.object(network.HTTPAdapter, "send", side_effect=[requests.ConnectionError(), requests.ConnectionError(), self.response(200)]), \
             patch.object(network, "save_routes"):
            self.assertEqual(network.FallbackAdapter().send(self.request, timeout=30).status_code, 200)
        self.assertEqual(network.ROUTES["example.com"], "socks5h://relay:1080")

    def test_html_bot_page_is_not_accepted_as_pdf(self):
        self.request = requests.Request("GET", "https://example.com/article/pdf").prepare()
        bot = self.response(200)
        bot.headers["Content-Type"] = "text/html"
        with patch.object(network, "candidates", return_value=["socks5h://primary:1080"]), \
             patch.object(network.HTTPAdapter, "send", side_effect=[bot, self.response(200)]) as send, \
             patch.object(network, "save_routes"):
            network.FallbackAdapter().send(self.request, timeout=30)
        self.assertEqual(send.call_count, 2)

    def test_retry_after_is_left_to_pipeline_backoff(self):
        response = self.response(503)
        response.headers["Retry-After"] = "60"
        with patch.object(network.HTTPAdapter, "send", return_value=response) as send:
            network.FallbackAdapter().send(self.request, timeout=30)
        self.assertEqual(send.call_count, 1)

    def test_interrupted_stream_uses_another_route_on_pipeline_retry(self):
        broken = self.response(200)
        def chunks(*args, **kwargs):
            yield b"partial"
            raise requests.ConnectionError("connection cut")
        broken.iter_content = chunks
        with patch.object(network, "candidates", return_value=["socks5h://primary:1080"]), \
             patch.object(network.HTTPAdapter, "send", side_effect=[broken, self.response(200)]) as send, \
             patch.object(network, "save_routes"):
            adapter = network.FallbackAdapter()
            response = adapter.send(self.request, timeout=30, proxies={})
            with self.assertRaises(requests.ConnectionError):
                list(response.iter_content(1024))
            adapter.send(self.request, timeout=30, proxies={})
        self.assertEqual(send.call_args.kwargs["proxies"]["https"], "socks5h://primary:1080")


if __name__ == "__main__":
    unittest.main()
