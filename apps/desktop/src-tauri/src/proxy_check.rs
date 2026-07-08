//! Live proxy testing shared by Tauri IPC and the local automation API.

use std::time::Instant;

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProxyCheckConfig {
    #[serde(rename = "type")]
    proxy_type: String,
    host: String,
    port: u16,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    password: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoInfo {
    pub ip: String,
    pub country_code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub city: Option<String>,
    pub timezone: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub longitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_datacenter: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyCheckResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geo: Option<GeoInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IpApiResponse {
    status: String,
    #[serde(default)]
    message: Option<String>,
    #[serde(default, rename = "query")]
    ip: Option<String>,
    #[serde(default, rename = "countryCode")]
    country_code: Option<String>,
    #[serde(default)]
    region: Option<String>,
    #[serde(default)]
    city: Option<String>,
    #[serde(default)]
    timezone: Option<String>,
    #[serde(default, rename = "lat")]
    latitude: Option<f64>,
    #[serde(default, rename = "lon")]
    longitude: Option<f64>,
    #[serde(default, rename = "as")]
    asn: Option<String>,
    #[serde(default, rename = "hosting")]
    is_datacenter: Option<bool>,
}

pub async fn run_proxy_check(config: serde_json::Value) -> ProxyCheckResult {
    let config: ProxyCheckConfig = match serde_json::from_value(config) {
        Ok(config) => config,
        Err(err) => {
            return ProxyCheckResult {
                ok: false,
                latency_ms: None,
                geo: None,
                error: Some(format!("Invalid proxy config: {err}")),
            };
        }
    };

    let scheme = match config.proxy_type.as_str() {
        "http" => "http",
        "https" => "https",
        "socks5" => "socks5h",
        other => {
            return ProxyCheckResult {
                ok: false,
                latency_ms: None,
                geo: None,
                error: Some(format!("Unsupported proxy type: {other}")),
            };
        }
    };

    let mut proxy_url =
        match reqwest::Url::parse(&format!("{scheme}://{}:{}", config.host, config.port)) {
            Ok(url) => url,
            Err(err) => {
                return ProxyCheckResult {
                    ok: false,
                    latency_ms: None,
                    geo: None,
                    error: Some(format!("Invalid proxy endpoint: {err}")),
                };
            }
        };
    if let Some(username) = config.username.as_deref().filter(|v| !v.is_empty()) {
        if proxy_url.set_username(username).is_err() {
            return ProxyCheckResult {
                ok: false,
                latency_ms: None,
                geo: None,
                error: Some("Invalid proxy username.".to_string()),
            };
        }
    }
    if let Some(password) = config.password.as_deref().filter(|v| !v.is_empty()) {
        if proxy_url.set_password(Some(password)).is_err() {
            return ProxyCheckResult {
                ok: false,
                latency_ms: None,
                geo: None,
                error: Some("Invalid proxy password.".to_string()),
            };
        }
    }

    let proxy = match reqwest::Proxy::all(proxy_url.as_str()) {
        Ok(proxy) => proxy,
        Err(err) => {
            return ProxyCheckResult {
                ok: false,
                latency_ms: None,
                geo: None,
                error: Some(format!("Could not configure proxy: {err}")),
            };
        }
    };
    let client = match reqwest::Client::builder()
        .proxy(proxy)
        .timeout(std::time::Duration::from_secs(12))
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            return ProxyCheckResult {
                ok: false,
                latency_ms: None,
                geo: None,
                error: Some(format!("Could not build proxy client: {err}")),
            };
        }
    };

    let started = Instant::now();
    let response = match client
        .get("http://ip-api.com/json/?fields=status,message,countryCode,region,city,timezone,lat,lon,as,hosting,query")
        .send()
        .await
    {
        Ok(response) => response,
        Err(err) => {
            return ProxyCheckResult {
                ok: false,
                latency_ms: Some(started.elapsed().as_millis() as i64),
                geo: None,
                error: Some(format!("Proxy request failed: {err}")),
            };
        }
    };

    let latency_ms = started.elapsed().as_millis() as i64;
    let lookup = match response.json::<IpApiResponse>().await {
        Ok(lookup) => lookup,
        Err(err) => {
            return ProxyCheckResult {
                ok: false,
                latency_ms: Some(latency_ms),
                geo: None,
                error: Some(format!("Could not parse proxy geo response: {err}")),
            };
        }
    };

    if lookup.status != "success" {
        return ProxyCheckResult {
            ok: false,
            latency_ms: Some(latency_ms),
            geo: None,
            error: Some(
                lookup
                    .message
                    .unwrap_or_else(|| "Proxy geo lookup failed.".to_string()),
            ),
        };
    }

    ProxyCheckResult {
        ok: true,
        latency_ms: Some(latency_ms),
        geo: Some(GeoInfo {
            ip: lookup.ip.unwrap_or_default(),
            country_code: lookup.country_code.unwrap_or_default(),
            region: lookup.region,
            city: lookup.city,
            timezone: lookup.timezone.unwrap_or_default(),
            latitude: lookup.latitude,
            longitude: lookup.longitude,
            asn: lookup.asn,
            is_datacenter: lookup.is_datacenter,
        }),
        error: None,
    }
}
