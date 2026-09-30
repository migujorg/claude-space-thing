// Display units. These are DEFINITIONS of units, not measurements of the universe.

/**
 * The astronomical unit, in km. A defined constant, exact by definition:
 * IAU 2012 Resolution B2, "On the re-definition of the astronomical unit of length"
 * (149 597 870 700 m exactly). Used only to display distances.
 */
export const AU_KM = 149_597_870.7;

export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 3600;
export const SECONDS_PER_DAY = 86400;
/** Julian year (IAU), 365.25 days — a unit, used only for display. */
export const SECONDS_PER_JULIAN_YEAR = 365.25 * SECONDS_PER_DAY;
