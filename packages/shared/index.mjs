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
export const validateIdCard = shared.validateIdCard;
export const parseIdCard = shared.parseIdCard;
export const calcAge = shared.calcAge;
export const checkMedicalRange = shared.checkMedicalRange;
export const checkAdvisory = shared.checkAdvisory;
/* 专病建档 */
export const INSURANCE_TYPES = shared.INSURANCE_TYPES;
export const SMOKING_HISTORY = shared.SMOKING_HISTORY;
export const DRINKING_HISTORY = shared.DRINKING_HISTORY;
export const DIET_HABITS = shared.DIET_HABITS;
export const ACTIVITY_LEVELS = shared.ACTIVITY_LEVELS;
export const YES_NO = shared.YES_NO;
export const DISCOVERY_TYPES = shared.DISCOVERY_TYPES;
export const GENDER_OPTIONS = shared.GENDER_OPTIONS;
export const MEDICAL_RECORD_SECTIONS = shared.MEDICAL_RECORD_SECTIONS;
export const MEDICAL_RECORD_KEYS = shared.MEDICAL_RECORD_KEYS;
export const recordCompleteness = shared.recordCompleteness;
/* 筛查识别 */
export const SCREENING_LAB_RULES = shared.SCREENING_LAB_RULES;
export const SCREENING_BMI_RULES = shared.SCREENING_BMI_RULES;
export const SCREENING_ULTRASOUND_KEYWORDS = shared.SCREENING_ULTRASOUND_KEYWORDS;
export const evaluateScreening = shared.evaluateScreening;
/* 风险分层 */
export const riskStratify = shared.riskStratify;
/* 随访管理 */
export const FOLLOWUP_CYCLES = shared.FOLLOWUP_CYCLES;
export const suggestFollowupDate = shared.suggestFollowupDate;
export const FOLLOWUP_STATUS = shared.FOLLOWUP_STATUS;
export const FOLLOWUP_STATUS_LABELS = shared.FOLLOWUP_STATUS_LABELS;
export const followupStatusOf = shared.followupStatusOf;
/* 预警 */
export const ALERT_LEVELS = shared.ALERT_LEVELS;
export const ALERT_TYPES = shared.ALERT_TYPES;
export const ALERT_TYPE_LABELS = shared.ALERT_TYPE_LABELS;
export default shared;
