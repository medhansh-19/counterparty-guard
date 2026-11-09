use near_sdk::{PanicOnDefault, env, near};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Receiver {
    last_memo: String,
    count: u64,
}

#[near]
impl Receiver {
    #[init]
    pub fn new() -> Self {
        Self {
            last_memo: String::new(),
            count: 0,
        }
    }

    /// A synchronous operation: a successful receipt proves this state change.
    #[payable]
    pub fn record(&mut self, memo: String) -> String {
        assert!(memo.encode_utf16().count() <= 256, "MEMO_TOO_LONG");
        assert!(memo != "fixture:fail", "FIXTURE_FAILURE");
        self.count = self.count.checked_add(1).expect("COUNT_OVERFLOW");
        self.last_memo = memo;
        env::log_str("fixture.record succeeded");
        "recorded".to_owned()
    }

    pub fn get_count(&self) -> u64 {
        self.count
    }
    pub fn get_memo(&self) -> String {
        self.last_memo.clone()
    }
}
