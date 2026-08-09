package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// AutoDisableConfig controls the auto-disable behavior of API keys
type AutoDisableConfig struct {
	Enabled                  bool `json:"enabled"`
	CooldownRecoverThreshold int  `json:"cooldown_recover_threshold"`
	ErrorRateThreshold       float64 `json:"error_rate_threshold"`
	ErrorRateMinSamples      int    `json:"error_rate_min_samples"`
}

// DefaultAutoDisable returns the default auto-disable settings
func DefaultAutoDisable() AutoDisableConfig {
	return AutoDisableConfig{
		Enabled:                  true,
		CooldownRecoverThreshold: 3,
		ErrorRateThreshold:       0.8,
		ErrorRateMinSamples:      50,
	}
}

// Config is the runtime configuration
type Config struct {
	Host            string           `json:"host"`
	Port            string           `json:"port"`
	UpstreamBase    string           `json:"upstream_base"`
	CooldownSeconds int              `json:"cooldown_seconds"`
	SyncIntervalH   int              `json:"sync_interval_hours"`
	AutoDisable     AutoDisableConfig `json:"auto_disable"`
	Debug           bool             `json:"debug"`

	mu  sync.RWMutex `json:"-"`
	Dir string       `json:"-"`
}

// Default returns the default configuration
func Default() *Config {
	return &Config{
		Host:            "0.0.0.0",
		Port:            "55990",
		UpstreamBase:    "https://api.commandcode.ai",
		CooldownSeconds: 300,
		SyncIntervalH:   24,
		AutoDisable:     DefaultAutoDisable(),
		Debug:           false,
	}
}

// Load reads config.json from the given directory, merging with defaults.
// Missing file is fine; defaults are used.
func Load(dir string) (*Config, error) {
	cfg := Default()
	cfg.Dir = dir

	path := filepath.Join(dir, "config.json")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return nil, err
	}

	var user struct {
		Host            *string           `json:"host"`
		Port            *string           `json:"port"`
		UpstreamBase    *string           `json:"upstream_base"`
		CooldownSeconds *int              `json:"cooldown_seconds"`
		SyncIntervalH   *int              `json:"sync_interval_hours"`
		AutoDisable     *AutoDisableConfig `json:"auto_disable"`
		Debug           *bool             `json:"debug"`
	}
	if err := json.Unmarshal(data, &user); err != nil {
		return nil, err
	}
	if user.Host != nil {
		cfg.Host = *user.Host
	}
	if user.Port != nil {
		cfg.Port = *user.Port
	}
	if user.UpstreamBase != nil {
		cfg.UpstreamBase = *user.UpstreamBase
	}
	if user.CooldownSeconds != nil {
		cfg.CooldownSeconds = *user.CooldownSeconds
	}
	if user.SyncIntervalH != nil {
		cfg.SyncIntervalH = *user.SyncIntervalH
	}
	if user.AutoDisable != nil {
		cfg.AutoDisable = *user.AutoDisable
	}
	if user.Debug != nil {
		cfg.Debug = *user.Debug
	}
	return cfg, nil
}

// Get returns a shallow copy of the config (thread-safe read)
func (c *Config) Get() Config {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return *c
}

// Update applies a partial update from a map (panel settings form)
func (c *Config) Update(m map[string]any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if v, ok := m["host"].(string); ok && v != "" {
		c.Host = v
	}
	if v, ok := m["port"].(string); ok && v != "" {
		c.Port = v
	}
	if v, ok := m["upstream_base"].(string); ok && v != "" {
		c.UpstreamBase = v
	}
	if v, ok := m["cooldown_seconds"].(float64); ok && v > 0 {
		c.CooldownSeconds = int(v)
	}
	if v, ok := m["sync_interval_hours"].(float64); ok && v >= 0 {
		c.SyncIntervalH = int(v)
	}
	if v, ok := m["debug"].(bool); ok {
		c.Debug = v
	}
	if v, ok := m["auto_disable"].(map[string]any); ok {
		if b, ok2 := v["enabled"].(bool); ok2 {
			c.AutoDisable.Enabled = b
		}
		if f, ok2 := v["cooldown_recover_threshold"].(float64); ok2 && f > 0 {
			c.AutoDisable.CooldownRecoverThreshold = int(f)
		}
		if f, ok2 := v["error_rate_threshold"].(float64); ok2 && f > 0 {
			c.AutoDisable.ErrorRateThreshold = f
		}
		if f, ok2 := v["error_rate_min_samples"].(float64); ok2 && f > 0 {
			c.AutoDisable.ErrorRateMinSamples = int(f)
		}
	}
}

// Save persists the config to config.json
func (c *Config) Save() error {
	c.mu.RLock()
	defer c.mu.RUnlock()
	path := filepath.Join(c.Dir, "config.json")
	if err := os.MkdirAll(c.Dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// GetCooldownSeconds returns the cooldown duration
func (c *Config) GetCooldownSeconds() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.CooldownSeconds <= 0 {
		return 300
	}
	return c.CooldownSeconds
}
