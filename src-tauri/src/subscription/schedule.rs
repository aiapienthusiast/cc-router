//! Slot time-schedule rules: per subscription slot, an ordered list of weekly time windows
//! that override the slot's default model while the local wall clock is inside them.
//!
//! The rule shape and evaluation semantics are shared with the frontend through
//! `src/lib/slot-schedule-cases.json` (the TS evaluator and the tests here read the same table).

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::virtual_model::model::SubscriptionSlot;

pub const MAX_RULES_PER_SLOT: usize = 16;

const MINUTES_PER_DAY: u16 = 1440;

/// One weekly window. `days` are ISO weekdays (1 = Monday .. 7 = Sunday) and name the day on
/// which the window STARTS. `start > end` means the window crosses midnight into the next day
/// (so Fri 18:00-08:00 covers Sat 00:00-08:00). `end` may be `24:00`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScheduleRule {
    pub days: Vec<u8>,
    pub start: String,
    pub end: String,
    pub model: String,
}

/// Per-slot rule lists. Same serde recipe as `SlotEfforts`: old rows (`'{}'`) deserialize to
/// all-empty, unknown keys are ignored.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SlotSchedules {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fable: Vec<ScheduleRule>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub opus: Vec<ScheduleRule>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sonnet: Vec<ScheduleRule>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub haiku: Vec<ScheduleRule>,
}

impl SlotSchedules {
    pub fn get(&self, slot: SubscriptionSlot) -> &[ScheduleRule] {
        match slot {
            SubscriptionSlot::Fable => &self.fable,
            SubscriptionSlot::Opus => &self.opus,
            SubscriptionSlot::Sonnet => &self.sonnet,
            SubscriptionSlot::Haiku => &self.haiku,
        }
    }

    pub fn get_mut(&mut self, slot: SubscriptionSlot) -> &mut Vec<ScheduleRule> {
        match slot {
            SubscriptionSlot::Fable => &mut self.fable,
            SubscriptionSlot::Opus => &mut self.opus,
            SubscriptionSlot::Sonnet => &mut self.sonnet,
            SubscriptionSlot::Haiku => &mut self.haiku,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.fable.is_empty()
            && self.opus.is_empty()
            && self.sonnet.is_empty()
            && self.haiku.is_empty()
    }
}

/// Local wall-clock reading used for evaluation. `weekday` is 1 (Monday) ..= 7 (Sunday).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WallClock {
    pub weekday: u8,
    /// Minutes since local midnight, 0..1440.
    pub minute: u16,
}

impl WallClock {
    pub fn now() -> Self {
        Self::from_naive(chrono::Local::now().naive_local())
    }

    pub fn from_naive(dt: chrono::NaiveDateTime) -> Self {
        use chrono::{Datelike, Timelike};
        Self {
            weekday: dt.weekday().number_from_monday() as u8,
            minute: (dt.hour() * 60 + dt.minute()) as u16,
        }
    }
}

/// Strict `HH:MM` (two digits each) to minutes since midnight. `24:00` is accepted (= 1440),
/// anything else past 23:59 is not.
fn parse_hhmm(s: &str) -> Option<u16> {
    let b = s.as_bytes();
    if b.len() != 5 || b[2] != b':' {
        return None;
    }
    if ![0, 1, 3, 4].iter().all(|&i| b[i].is_ascii_digit()) {
        return None;
    }
    let h = u16::from(b[0] - b'0') * 10 + u16::from(b[1] - b'0');
    let m = u16::from(b[3] - b'0') * 10 + u16::from(b[4] - b'0');
    if m > 59 || h > 24 || (h == 24 && m != 0) {
        return None;
    }
    Some(h * 60 + m)
}

fn prev_weekday(d: u8) -> u8 {
    if d <= 1 {
        7
    } else {
        d - 1
    }
}

/// Whether a (well-formed) rule covers `at`. Malformed rules never match.
fn rule_matches(rule: &ScheduleRule, at: WallClock) -> bool {
    let (Some(s), Some(e)) = (parse_hhmm(&rule.start), parse_hhmm(&rule.end)) else {
        return false;
    };
    if s >= MINUTES_PER_DAY || s == e {
        return false;
    }
    let today = rule.days.contains(&at.weekday);
    if s < e {
        today && s <= at.minute && at.minute < e
    } else {
        (today && at.minute >= s)
            || (rule.days.contains(&prev_weekday(at.weekday)) && at.minute < e)
    }
}

/// Model to use right now: first matching rule wins (list order), else the slot default.
/// Both results are trimmed, blank means `None`.
pub fn effective_model<'a>(
    default: &'a str,
    rules: &'a [ScheduleRule],
    at: WallClock,
) -> Option<&'a str> {
    let pick = |m: &'a str| {
        let m = m.trim();
        (!m.is_empty()).then_some(m)
    };
    rules
        .iter()
        .filter(|r| rule_matches(r, at))
        .find_map(|r| pick(&r.model))
        .or_else(|| pick(default))
}

fn slot_label(slot: SubscriptionSlot) -> &'static str {
    match slot {
        SubscriptionSlot::Fable => "fable",
        SubscriptionSlot::Opus => "opus",
        SubscriptionSlot::Sonnet => "sonnet",
        SubscriptionSlot::Haiku => "haiku",
    }
}

fn validate_rule(rule: &ScheduleRule) -> Result<(), &'static str> {
    if rule.days.is_empty() {
        return Err("至少选择一个星期");
    }
    let mut seen = HashSet::new();
    for &d in &rule.days {
        if !(1..=7).contains(&d) {
            return Err("星期必须在 1-7 之间");
        }
        if !seen.insert(d) {
            return Err("星期重复");
        }
    }
    let half_hour = |s: &str| parse_hhmm(s).filter(|m| m % 30 == 0);
    let Some(start) = half_hour(&rule.start) else {
        return Err("开始时间必须是整点或半点");
    };
    if start >= MINUTES_PER_DAY {
        return Err("开始时间不能是 24:00");
    }
    let Some(end) = half_hour(&rule.end) else {
        return Err("结束时间必须是整点或半点");
    };
    if start == end {
        return Err("开始与结束时间不能相同");
    }
    if rule.model.trim().is_empty() {
        return Err("模型不能为空");
    }
    Ok(())
}

pub fn validate_slot_schedules(s: &SlotSchedules) -> Result<(), String> {
    for slot in [
        SubscriptionSlot::Fable,
        SubscriptionSlot::Opus,
        SubscriptionSlot::Sonnet,
        SubscriptionSlot::Haiku,
    ] {
        let rules = s.get(slot);
        let label = slot_label(slot);
        if rules.len() > MAX_RULES_PER_SLOT {
            return Err(format!("{label} 的时段规则最多 {MAX_RULES_PER_SLOT} 条"));
        }
        for (i, rule) in rules.iter().enumerate() {
            validate_rule(rule).map_err(|msg| format!("{label} 第 {} 条时段: {msg}", i + 1))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::virtual_model::model::SubscriptionSlot;

    const CASES: &str = include_str!("../../../src/lib/slot-schedule-cases.json");

    #[derive(serde::Deserialize)]
    struct At {
        weekday: u8,
        time: String,
    }

    #[derive(serde::Deserialize)]
    struct Case {
        name: String,
        default: String,
        rules: Vec<ScheduleRule>,
        at: At,
        expect: Option<String>,
    }

    #[test]
    fn shared_cases() {
        let cases: Vec<Case> = serde_json::from_str(CASES).expect("slot-schedule-cases.json");
        assert!(cases.len() >= 15);
        for c in cases {
            let at = WallClock {
                weekday: c.at.weekday,
                minute: parse_hhmm(&c.at.time).expect(&c.name),
            };
            let got = effective_model(&c.default, &c.rules, at);
            assert_eq!(got, c.expect.as_deref(), "case: {}", c.name);
        }
    }

    fn rule(days: &[u8], start: &str, end: &str, model: &str) -> ScheduleRule {
        ScheduleRule {
            days: days.to_vec(),
            start: start.into(),
            end: end.into(),
            model: model.into(),
        }
    }

    fn with_opus(rules: Vec<ScheduleRule>) -> SlotSchedules {
        SlotSchedules {
            opus: rules,
            ..Default::default()
        }
    }

    fn err_of(rules: Vec<ScheduleRule>) -> String {
        validate_slot_schedules(&with_opus(rules)).expect_err("should be rejected")
    }

    #[test]
    fn validate_accepts_qoder_pair() {
        let s = with_opus(vec![
            rule(&[1, 2, 3, 4, 5], "08:00", "18:00", "deepseek-4.1"),
            rule(&[1, 2, 3, 4, 5], "18:00", "08:00", "qwen-max"),
        ]);
        assert!(validate_slot_schedules(&s).is_ok());
        assert!(validate_slot_schedules(&SlotSchedules::default()).is_ok());
        // 24:00 is a legal end, 00:30 a legal half-hour
        assert!(
            validate_slot_schedules(&with_opus(vec![rule(&[7], "00:30", "24:00", "m")])).is_ok()
        );
        assert!(
            validate_slot_schedules(&with_opus(vec![rule(&[1], "00:00", "24:00", "m")])).is_ok()
        );
    }

    #[test]
    fn validate_rejects_bad_times() {
        let e = err_of(vec![rule(&[1], "08:15", "18:00", "m")]);
        assert!(e.contains("opus") && e.contains("第 1 条"), "{e}");
        assert!(e.contains("整点或半点"), "{e}");
        assert!(err_of(vec![rule(&[1], "08:00", "18:20", "m")]).contains("整点或半点"));
        assert!(err_of(vec![rule(&[1], "24:00", "08:00", "m")]).contains("24:00"));
        assert!(err_of(vec![rule(&[1], "8:00", "18:00", "m")]).contains("整点或半点"));
        assert!(err_of(vec![rule(&[1], "25:00", "18:00", "m")]).contains("整点或半点"));
        assert!(err_of(vec![rule(&[1], "08:00", "08:00", "m")]).contains("不能相同"));
    }

    #[test]
    fn validate_rejects_bad_days_model_count() {
        assert!(err_of(vec![rule(&[], "08:00", "18:00", "m")]).contains("星期"));
        assert!(err_of(vec![rule(&[0], "08:00", "18:00", "m")]).contains("星期"));
        assert!(err_of(vec![rule(&[8], "08:00", "18:00", "m")]).contains("星期"));
        assert!(err_of(vec![rule(&[1, 1], "08:00", "18:00", "m")]).contains("重复"));
        assert!(err_of(vec![rule(&[1], "08:00", "18:00", "  ")]).contains("模型"));
        let many: Vec<_> = (0..17).map(|_| rule(&[1], "08:00", "18:00", "m")).collect();
        assert!(err_of(many).contains("16"));
        let ok: Vec<_> = (0..16).map(|_| rule(&[1], "08:00", "18:00", "m")).collect();
        assert!(validate_slot_schedules(&with_opus(ok)).is_ok());
    }

    #[test]
    fn validate_reports_one_based_index_and_slot() {
        let s = SlotSchedules {
            haiku: vec![
                rule(&[1], "08:00", "18:00", "m"),
                rule(&[1], "08:15", "18:00", "m"),
            ],
            ..Default::default()
        };
        let e = validate_slot_schedules(&s).unwrap_err();
        assert!(e.starts_with("haiku 第 2 条时段"), "{e}");
    }

    #[test]
    fn serde_roundtrip_and_unknown_fields() {
        let s: SlotSchedules = serde_json::from_str("{}").unwrap();
        assert_eq!(s, SlotSchedules::default());
        assert!(s.is_empty());
        assert_eq!(serde_json::to_string(&s).unwrap(), "{}");

        let s: SlotSchedules = serde_json::from_str(
            r#"{"jev":[{"days":[1],"start":"08:00","end":"09:00","model":"x"}],
                "sonnet":[{"days":[1],"start":"08:00","end":"09:00","model":"y"}]}"#,
        )
        .unwrap();
        assert_eq!(s.get(SubscriptionSlot::Sonnet).len(), 1);
        assert!(s.get(SubscriptionSlot::Opus).is_empty());
        assert!(!s.is_empty());
        let back: SlotSchedules =
            serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn get_mut_targets_the_right_slot() {
        let mut s = SlotSchedules::default();
        s.get_mut(SubscriptionSlot::Fable)
            .push(rule(&[1], "08:00", "09:00", "m"));
        assert_eq!(s.fable.len(), 1);
        assert!(s.haiku.is_empty());
    }

    #[test]
    fn wall_clock_from_naive() {
        // 2026-10-24 is a Saturday
        let dt = chrono::NaiveDate::from_ymd_opt(2026, 10, 24)
            .unwrap()
            .and_hms_opt(7, 45, 30)
            .unwrap();
        assert_eq!(
            WallClock::from_naive(dt),
            WallClock {
                weekday: 6,
                minute: 7 * 60 + 45
            }
        );
        let w = WallClock::now();
        assert!((1..=7).contains(&w.weekday) && w.minute < 1440);
    }

    #[test]
    fn malformed_rules_are_skipped_at_eval() {
        let rules = vec![
            rule(&[1], "garbage", "18:00", "bad"),
            rule(&[1], "08:00", "18:00", "good"),
        ];
        let at = WallClock {
            weekday: 1,
            minute: 600,
        };
        assert_eq!(effective_model("", &rules, at), Some("good"));
    }

    #[test]
    fn model_is_trimmed() {
        let rules = vec![rule(&[1], "08:00", "18:00", "  m  ")];
        let at = WallClock {
            weekday: 1,
            minute: 600,
        };
        assert_eq!(effective_model("", &rules, at), Some("m"));
        assert_eq!(effective_model(" d ", &[], at), Some("d"));
    }
}
