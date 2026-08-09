package keypool

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ApiKey is a single upstream API key with runtime state
type ApiKey struct {
	Key                  string  `json:"key"`
	Name                 string  `json:"name"`
	Enabled              bool    `json:"enabled"`
	CooldownUntil        float64 `json:"cooldown_until"`
	RequestCount         int64   `json:"request_count"`
	ErrorCount           int64   `json:"error_count"`
	LastUsed             float64 `json:"last_used"`
	LastError            string  `json:"last_error"`
	AddedAt              float64 `json:"added_at"`
	DisabledReason       string  `json:"disabled_reason"`
	DisabledAt           float64 `json:"disabled_at"`
	CooldownRecoverCount int     `json:"cooldown_recover_count"`
	EscalationCount      int    `json:"escalation_count"`
}

func (k *ApiKey) isCooling() bool {
	return k.CooldownUntil > float64(time.Now().Unix())
}

func (k *ApiKey) isAvailable() bool {
	return k.Enabled && !k.isCooling() && k.DisabledReason == ""
}

func (k *ApiKey) shortKey() string {
	if len(k.Key) <= 12 {
		return "***"
	}
	return k.Key[:8] + "..." + k.Key[len(k.Key)-4:]
}

// ShortKeyForPanel returns a masked view of the key for the panel
func (k *ApiKey) ShortKeyForPanel() string {
	return k.shortKey()
}

// ToDict returns a JSON-friendly view
func (k *ApiKey) ToDict() map[string]any {
	now := float64(time.Now().Unix())
	return map[string]any{
		"key":                   k.Key,
		"name":                  k.Name,
		"enabled":               k.Enabled,
		"cooldown_until":        k.CooldownUntil,
		"request_count":         k.RequestCount,
		"error_count":           k.ErrorCount,
		"last_used":             k.LastUsed,
		"last_error":            k.LastError,
		"added_at":              k.AddedAt,
		"disabled_reason":       k.DisabledReason,
		"disabled_at":           k.DisabledAt,
		"cooldown_recover_count": k.CooldownRecoverCount,
		"escalation_count":      k.EscalationCount,
		"is_available":          k.isAvailable(),
		"is_cooling":            k.isCooling(),
		"short_key":             k.shortKey(),
		"cooldown_left":         int64(k.CooldownUntil - now),
	}
}

// AutoDisableConfig mirrors config.AutoDisableConfig (kept here to avoid import cycle)
type AutoDisableConfig struct {
	Enabled                  bool
	CooldownRecoverThreshold int
	ErrorRateThreshold       float64
	ErrorRateMinSamples      int
}

// KeyManager manages the pool of API keys
type KeyManager struct {
	dataPath    string
	cooldownSec int
	autoDisable AutoDisableConfig

	mu     sync.Mutex
	keys   []*ApiKey
	index  int
	dirty  bool
	lastSave time.Time
	saveInterval time.Duration
}

const saveInterval = 5 * time.Second

// NewKeyManager creates a KeyManager; dataDir is where keys.json lives
func NewKeyManager(dataDir string, cooldownSec int, ad AutoDisableConfig) *KeyManager {
	km := &KeyManager{
		dataPath:      filepath.Join(dataDir, "keys.json"),
		cooldownSec:   cooldownSec,
		autoDisable:   ad,
		saveInterval:  saveInterval,
		lastSave:      time.Now(),
	}
	km.load()
	return km
}

func (km *KeyManager) load() {
	data, err := os.ReadFile(km.dataPath)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("[keypool] load keys failed: %v", err)
		}
		km.keys = []*ApiKey{}
		return
	}
	var raw []*ApiKey
	if err := json.Unmarshal(data, &raw); err != nil {
		log.Printf("[keypool] parse keys failed: %v", err)
		km.keys = []*ApiKey{}
		return
	}
	km.keys = raw
	if km.keys == nil {
		km.keys = []*ApiKey{}
	}
	log.Printf("[keypool] loaded %d API key(s)", len(km.keys))
}

// save persists keys with throttling; force skips the interval check
func (km *KeyManager) save(force bool) {
	km.dirty = true
	if !force && time.Since(km.lastSave) < km.saveInterval {
		return
	}
	km.flush()
}

func (km *KeyManager) flush() {
	data, err := json.MarshalIndent(km.keys, "", "  ")
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(km.dataPath), 0o755); err != nil {
		log.Printf("[keypool] mkdir failed: %v", err)
		return
	}
	if err := os.WriteFile(km.dataPath, data, 0o644); err != nil {
		log.Printf("[keypool] save failed: %v", err)
		return
	}
	km.lastSave = time.Now()
	km.dirty = false
}

// AddKey adds a new key
func (km *KeyManager) AddKey(key, name string) (*ApiKey, error) {
	km.mu.Lock()
	defer km.mu.Unlock()
	for _, k := range km.keys {
		if k.Key == key {
			return nil, errKeyExists
		}
	}
	apiKey := &ApiKey{
		Key:     key,
		Name:    name,
		Enabled: true,
		AddedAt: float64(time.Now().Unix()),
	}
	if apiKey.Name == "" {
		apiKey.Name = "Key-" + itoa(len(km.keys)+1)
	}
	km.keys = append(km.keys, apiKey)
	km.save(true)
	log.Printf("[keypool] added key %s (%s)", apiKey.Name, apiKey.shortKey())
	return apiKey, nil
}

var errKeyExists = &KeyExistsError{}

// KeyExistsError is returned when adding a duplicate key
type KeyExistsError struct{}

func (e *KeyExistsError) Error() string { return "该 Key 已存在" }

// RemoveKey deletes a key
func (km *KeyManager) RemoveKey(key string) bool {
	km.mu.Lock()
	defer km.mu.Unlock()
	for i, k := range km.keys {
		if k.Key == key {
			km.keys = append(km.keys[:i], km.keys[i+1:]...)
			km.save(true)
			log.Printf("[keypool] removed key %s", k.Name)
			return true
		}
	}
	return false
}

// ToggleKey toggles manual enable/disable; also allows manual override of quota-disabled keys
func (km *KeyManager) ToggleKey(key string) *ApiKey {
	km.mu.Lock()
	defer km.mu.Unlock()
	for _, k := range km.keys {
		if k.Key == key {
			now := float64(time.Now().Unix())
			switch {
			case !k.Enabled || k.DisabledReason == "manual":
				// re-enable fully
				k.Enabled = true
				k.DisabledReason = ""
				k.DisabledAt = 0
				k.CooldownUntil = 0
			case k.DisabledReason != "":
				// quota-disabled -> manual override restore
				k.DisabledReason = ""
				k.DisabledAt = 0
				k.CooldownUntil = 0
				k.EscalationCount = 0
			default:
				// active -> manual disable
				k.Enabled = false
				k.DisabledReason = "manual"
				k.DisabledAt = now
			}
			km.save(true)
			return k
		}
	}
	return nil
}

// RestoreKey clears quota-disable state (used by background scan)
func (km *KeyManager) RestoreKey(key string) *ApiKey {
	km.mu.Lock()
	defer km.mu.Unlock()
	for _, k := range km.keys {
		if k.Key == key {
			k.DisabledReason = ""
			k.DisabledAt = 0
			k.CooldownUntil = 0
			k.CooldownRecoverCount = 0
			km.save(true)
			log.Printf("[keypool] key %s restored", k.Name)
			return k
		}
	}
	return nil
}

// MarkError records an error and starts cooldown; may auto-disable
func (km *KeyManager) MarkError(key, errMsg string) {
	km.mu.Lock()
	defer km.mu.Unlock()
	now := float64(time.Now().Unix())
	for _, k := range km.keys {
		if k.Key == key {
			k.ErrorCount++
			k.LastError = errMsg

			// was the key recently recovered from cooldown before failing again?
			wasRecentlyRecovered := k.CooldownUntil > 0 && (k.CooldownUntil-now) < 60
			k.CooldownUntil = now + float64(km.cooldownSec)

			if wasRecentlyRecovered {
				k.CooldownRecoverCount++
			} else {
				k.CooldownRecoverCount = 0
			}

			km.checkAutoDisable(k, now)
			km.save(false)
			log.Printf("[keypool] key %s cooling %ds: %s", k.Name, km.cooldownSec, errMsg)
			return
		}
	}
}

// MarkSuccess records a successful request
func (km *KeyManager) MarkSuccess(key string) {
	km.mu.Lock()
	defer km.mu.Unlock()
	for _, k := range km.keys {
		if k.Key == key {
			k.RequestCount++
			k.LastUsed = float64(time.Now().Unix())
			if k.isCooling() {
				k.CooldownUntil = 0
			}
			k.CooldownRecoverCount = 0
			km.save(false)
			return
		}
	}
}

// MarkDisabledByQuota records a 5h/period quota hit (e.g. from health probe)
func (km *KeyManager) MarkDisabledByQuota(key, reason string) {
	km.mu.Lock()
	defer km.mu.Unlock()
	for _, k := range km.keys {
		if k.Key == key {
			k.DisabledReason = reason
			k.DisabledAt = float64(time.Now().Unix())
			km.save(true)
			log.Printf("[keypool] key %s auto-disabled (%s)", k.Name, reason)
			return
		}
	}
}

func (km *KeyManager) checkAutoDisable(k *ApiKey, now float64) {
	cfg := km.autoDisable
	if !cfg.Enabled {
		return
	}
	threshold := cfg.CooldownRecoverThreshold
	if threshold <= 0 {
		threshold = 3
	}
	if k.CooldownRecoverCount >= threshold {
		// quota escalation: repeated 5h hits escalate to period
		if k.DisabledReason == "5h_quota" {
			k.EscalationCount++
		} else {
			k.EscalationCount = 1
		}
		if k.EscalationCount >= 2 {
			k.DisabledReason = "period_quota"
		} else {
			k.DisabledReason = "5h_quota"
		}
		k.DisabledAt = now
		log.Printf("[keypool] key %s auto-disabled (%s) after %d recover-then-fail", k.Name, k.DisabledReason, k.CooldownRecoverCount)
	} else if k.ErrorCount >= int64(cfg.ErrorRateMinSamples) &&
		(float64(k.ErrorCount)/float64(max64(k.RequestCount, 1))) > cfg.ErrorRateThreshold {
		k.DisabledReason = "period_quota"
		k.DisabledAt = now
		log.Printf("[keypool] key %s auto-disabled (high error rate %d/%d)", k.Name, k.ErrorCount, k.RequestCount)
	}
}

// GetNext returns the next available key round-robin; nil if none
func (km *KeyManager) GetNext() *ApiKey {
	km.mu.Lock()
	defer km.mu.Unlock()
	if len(km.keys) == 0 {
		return nil
	}
	var available []*ApiKey
	for _, k := range km.keys {
		if k.isAvailable() {
			available = append(available, k)
		}
	}
	if len(available) == 0 {
		return nil
	}
	key := available[km.index%len(available)]
	km.index = (km.index + 1) % len(available)
	return key
}

// GetKey returns a key by its raw value
func (km *KeyManager) GetKey(key string) *ApiKey {
	km.mu.Lock()
	defer km.mu.Unlock()
	for _, k := range km.keys {
		if k.Key == key {
			return k
		}
	}
	return nil
}

// AllKeys returns all keys (snapshot)
func (km *KeyManager) AllKeys() []*ApiKey {
	km.mu.Lock()
	defer km.mu.Unlock()
	out := make([]*ApiKey, len(km.keys))
	copy(out, km.keys)
	return out
}

// Stats returns pool statistics
func (km *KeyManager) Stats() map[string]any {
	km.mu.Lock()
	defer km.mu.Unlock()
	now := float64(time.Now().Unix())
	var available, cooling, disabled, quotaDisabled int
	var totalReq, totalErr int64
	for _, k := range km.keys {
		totalReq += k.RequestCount
		totalErr += k.ErrorCount
		if k.isAvailable() {
			available++
		}
		if k.isCooling() {
			cooling++
		}
		if !k.Enabled {
			disabled++
		}
		if k.DisabledReason != "" && k.DisabledReason != "manual" {
			quotaDisabled++
		}
	}
	_ = now
	return map[string]any{
		"total":            len(km.keys),
		"available":        available,
		"cooling":          cooling,
		"disabled":         disabled,
		"disabled_by_quota": quotaDisabled,
		"total_requests":   totalReq,
		"total_errors":     totalErr,
	}
}

// Flush forces a save (used on shutdown)
func (km *KeyManager) Flush() {
	km.mu.Lock()
	defer km.mu.Unlock()
	km.flush()
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
