//! Language for user-facing backend messages (errors, hints, undo labels).
//! The webview sets it with the `set_locale` command; Korean is the default.
//! Every message is written in both languages at the call site:
//! `tr!("한국어", "English")` for plain text and `trf!("{x} 한국어", "{x} English")`
//! for format strings.

use std::sync::atomic::{AtomicBool, Ordering};

static ENGLISH: AtomicBool = AtomicBool::new(false);

pub fn set_english(on: bool) {
    ENGLISH.store(on, Ordering::Relaxed);
}

pub fn english() -> bool {
    ENGLISH.load(Ordering::Relaxed)
}

#[macro_export]
macro_rules! tr {
    ($ko:expr, $en:expr $(,)?) => {
        if $crate::i18n::english() {
            $en
        } else {
            $ko
        }
    };
}

#[macro_export]
macro_rules! trf {
    ($ko:literal, $en:literal $(, $($arg:tt)*)?) => {
        if $crate::i18n::english() {
            format!($en $(, $($arg)*)?)
        } else {
            format!($ko $(, $($arg)*)?)
        }
    };
}

#[cfg(test)]
mod tests {
    #[test]
    fn picks_the_language() {
        let n = 3;
        assert_eq!(trf!("{n}개", "{n} items"), "3개");
        assert_eq!(tr!("커밋", "Commit"), "커밋");
    }
}
