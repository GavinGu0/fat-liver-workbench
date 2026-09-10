import './index.js';

const shared = globalThis.FLWB_SHARED;

export const MED_RANGES = shared.MED_RANGES;
export const LAB_FIELDS = shared.LAB_FIELDS;
export const LAB_FIELDS_BY_KEY = shared.LAB_FIELDS_BY_KEY;
export const labAbnormalKeys = shared.labAbnormalKeys;
export const ADVISORY = shared.ADVISORY;
export const ROLES = shared.ROLES;
export const RISK_LEVELS = shared.RISK_LEVELS;
export const RISK_LABELS = shared.RISK_LABELS;
export const MEALS = shared.MEALS;
export const MEAL_LABELS = shared.MEAL_LABELS;
export const EXERCISE_TYPES = shared.EXERCISE_TYPES;
export const INTENSITIES = shared.INTENSITIES;
export const INTENSITY_LABELS = shared.INTENSITY_LABELS;
export const GUIDANCE_METHODS = shared.GUIDANCE_METHODS;
export const GUIDANCE_CATEGORIES = shared.GUIDANCE_CATEGORIES;
export const MDT_DEPTS = shared.MDT_DEPTS;
export const MDT_STATUS = shared.MDT_STATUS;
export const MDT_STATUS_LABELS = shared.MDT_STATUS_LABELS;
export const MESSAGE_TYPES = shared.MESSAGE_TYPES;
export const CLIENT_SALT = shared.CLIENT_SALT;
export const calcBmi = shared.calcBmi;
export const checkMedicalRange = shared.checkMedicalRange;
export const checkAdvisory = shared.checkAdvisory;
export default shared;
