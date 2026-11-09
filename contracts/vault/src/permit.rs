//! Borsh v1, byte-for-byte compatible with packages/shared. Decode lengths before allocation.
use borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::{AccountId, env};
use std::io::{Cursor, Read};

pub const DOMAIN: &str = "CounterpartyGuard/Permit";
pub const SIGNING_DOMAIN: &[u8] = b"CounterpartyGuard/PermitSignature/v1\0";
pub const MAX_TTL: u64 = 300_000;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq)]
pub enum Network {
    Sandbox,
    Testnet,
}
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq)]
pub enum Verdict {
    Allow,
    Warn,
}
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq)]
pub enum Action {
    Transfer {
        receiver: String,
        amount: u128,
    },
    Call {
        receiver: String,
        method: String,
        args: Vec<u8>,
        deposit: u128,
        gas: u64,
    },
}
impl Action {
    pub fn receiver(&self) -> &str {
        match self {
            Self::Transfer { receiver, .. } | Self::Call { receiver, .. } => receiver,
        }
    }
    pub fn amount(&self) -> u128 {
        match self {
            Self::Transfer { amount, .. } => *amount,
            Self::Call { deposit, .. } => *deposit,
        }
    }
}
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq)]
pub struct Permit {
    pub domain: String,
    pub version: u16,
    pub network: Network,
    pub deployment: [u8; 32],
    pub vault: String,
    pub agent: String,
    pub key: [u8; 32],
    pub action: Action,
    pub revision: u64,
    pub blocklist_revision: u64,
    pub evidence: [u8; 32],
    pub verdict: Verdict,
    pub nonce: [u8; 32],
    pub issued: u64,
    pub expires: u64,
}
fn read<T: BorshDeserialize>(r: &mut Cursor<&[u8]>) -> Result<T, String> {
    T::deserialize_reader(r).map_err(|_| "MALFORMED_PERMIT".into())
}
fn bytes(r: &mut Cursor<&[u8]>, max: usize) -> Result<Vec<u8>, String> {
    let len: u32 = read(r)?;
    if len as usize > max || len as u64 > r.get_ref().len() as u64 - r.position() {
        return Err("OVERSIZED_FIELD".into());
    }
    let mut buf = vec![0; len as usize];
    r.read_exact(&mut buf).map_err(|_| "TRUNCATED_PERMIT")?;
    Ok(buf)
}
fn string(r: &mut Cursor<&[u8]>, max: usize) -> Result<String, String> {
    String::from_utf8(bytes(r, max)?).map_err(|_| "INVALID_UTF8".into())
}
fn account(r: &mut Cursor<&[u8]>) -> Result<String, String> {
    let id = string(r, 64)?;
    id.parse::<AccountId>().map_err(|_| "INVALID_ACCOUNT")?;
    Ok(id)
}
impl Permit {
    pub fn decode(input: &[u8]) -> Result<Self, String> {
        if input.len() > 8192 {
            return Err("OVERSIZED_PERMIT".into());
        }
        let r = &mut Cursor::new(input);
        let domain = string(r, 32)?;
        let version = read(r)?;
        if domain != DOMAIN || version != 1 {
            return Err("PERMIT_VERSION".into());
        }
        let network = read(r)?;
        let deployment = read(r)?;
        let vault = account(r)?;
        let agent = account(r)?;
        let key = read(r)?;
        let action = match read::<u8>(r)? {
            0 => Action::Transfer {
                receiver: account(r)?,
                amount: read(r)?,
            },
            1 => {
                let receiver = account(r)?;
                let method = string(r, 64)?;
                if method.is_empty()
                    || !method.bytes().enumerate().all(|(i, c)| {
                        c.is_ascii_alphabetic() || c == b'_' || (i > 0 && c.is_ascii_digit())
                    })
                {
                    return Err("INVALID_METHOD".into());
                }
                let args = bytes(r, 4096)?;
                let deposit = read(r)?;
                let gas = read(r)?;
                if !(1..=300).contains(&gas) {
                    return Err("INVALID_GAS".into());
                }
                Action::Call {
                    receiver,
                    method,
                    args,
                    deposit,
                    gas,
                }
            }
            _ => return Err("UNKNOWN_ACTION".into()),
        };
        let permit = Self {
            domain,
            version,
            network,
            deployment,
            vault,
            agent,
            key,
            action,
            revision: read(r)?,
            blocklist_revision: read(r)?,
            evidence: read(r)?,
            verdict: read(r)?,
            nonce: read(r)?,
            issued: read(r)?,
            expires: read(r)?,
        };
        if r.position() != input.len() as u64 {
            return Err("TRAILING_BYTES".into());
        }
        if permit.expires > MAX_SAFE_INTEGER
            || permit.issued >= permit.expires
            || permit.expires - permit.issued > MAX_TTL
        {
            return Err("PERMIT_LIFETIME".into());
        }
        Ok(permit)
    }
    pub fn hash(&self) -> [u8; 32] {
        env::sha256_array(borsh::to_vec(self).expect("ENCODE_PERMIT"))
    }
    pub fn signing_message(&self) -> Vec<u8> {
        let mut message = SIGNING_DOMAIN.to_vec();
        message.extend_from_slice(&self.hash());
        message
    }
}
