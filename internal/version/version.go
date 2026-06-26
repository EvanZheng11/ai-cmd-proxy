package version

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"
)

var (
	cliVersion = "0.40.8" // 兜底版本
	versionMu  sync.RWMutex
	fetched    bool
)

const npmURL = "https://registry.npmjs.org/command-code/latest"

// GetCommandCodeVersion returns the CommandCode CLI version.
// First call blocks briefly to try fetching from npm; subsequent calls return cached value.
func GetCommandCodeVersion() string {
	versionMu.RLock()
	if fetched {
		v := cliVersion
		versionMu.RUnlock()
		return v
	}
	versionMu.RUnlock()

	// First call — try to fetch
	versionMu.Lock()
	defer versionMu.Unlock()
	if fetched {
		return cliVersion
	}
	fetched = true

	v, err := fetchVersion()
	if err != nil {
		log.Printf("[version] npm fetch failed, using fallback %s: %v", cliVersion, err)
		return cliVersion
	}
	cliVersion = v
	log.Printf("[version] fetched CLI version: %s", v)
	return cliVersion
}

func fetchVersion() (string, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(npmURL)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var result struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	if result.Version == "" {
		return "", nil
	}
	return result.Version, nil
}
