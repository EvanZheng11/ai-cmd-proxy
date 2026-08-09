package models

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ModelEntry describes one model in the registry
type ModelEntry struct {
	ID         string `json:"id"`          // full upstream id, e.g. deepseek/deepseek-v4-flash
	Vendor     string `json:"vendor"`      // company name from docs
	ShortName  string `json:"short_name"`  // name after '/', e.g. deepseek-v4-flash
	Name       string `json:"name"`        // display name
	ContextWin int64  `json:"context_window,omitempty"`
	Source     string `json:"source"`      // "builtin" | "synced"
}

// SyncStatus reports the last model sync result
type SyncStatus struct {
	LastSync     string `json:"last_sync"`     // RFC3339 or ""
	LastResult   string `json:"last_result"`   // "ok" | "error"
	LastCount    int    `json:"last_count"`
	LastMessage  string `json:"last_message"`  // error detail or summary
	NextSyncIn   int64  `json:"next_sync_in"`  // seconds; -1 disabled
	SyncInterval int    `json:"sync_interval_hours"`
}

// ModelStore holds the model registry with runtime updates
type ModelStore struct {
	mu    sync.RWMutex
	byID  map[string]*ModelEntry // key: lower(id)
	byS   map[string]*ModelEntry // key: lower(shortname)
	dataPath string
	status   SyncStatus
	intervalH int
}

// NewModelStore builds a store from builtin + persisted overrides
func NewModelStore(dataDir string, intervalH int) *ModelStore {
	s := &ModelStore{
		byID:      map[string]*ModelEntry{},
		byS:       map[string]*ModelEntry{},
		dataPath:  filepath.Join(dataDir, "models.json"),
		intervalH: intervalH,
	}
	s.seed(BuiltinModels)
	s.loadPersisted()
	s.refreshStatusLocked()
	return s
}

func (s *ModelStore) seed(list []ModelEntry) {
	for i := range list {
		e := list[i]
		if e.Source == "" {
			e.Source = "builtin"
		}
		s.index(&e)
	}
}

func (s *ModelStore) index(e *ModelEntry) {
	keyID := strings.ToLower(e.ID)
	keyS := strings.ToLower(e.ShortName)
	if keyID != "" {
		s.byID[keyID] = e
	}
	if keyS != "" && keyS != keyID {
		s.byS[keyS] = e
	}
}

func (s *ModelStore) loadPersisted() {
	data, err := os.ReadFile(s.dataPath)
	if err != nil {
		return
	}
	var list []ModelEntry
	if err := json.Unmarshal(data, &list); err != nil {
		log.Printf("[models] parse models.json failed: %v", err)
		return
	}
	if len(list) == 0 {
		return
	}
	// merged: synced entries override builtin by ID
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range list {
		e := list[i]
		key := strings.ToLower(e.ID)
		if cur, ok := s.byID[key]; ok {
			cur.Vendor = e.Vendor
			cur.ShortName = e.ShortName
			cur.Name = e.Name
			cur.ContextWin = e.ContextWin
			cur.Source = e.Source
		} else {
			s.index(&e)
		}
	}
}

// Resolve maps a client-supplied model name to the full upstream id.
// Rules (mirroring cmd --model): case-insensitive; accepts full id or short name.
// Unknown names pass through unchanged so the upstream can reject them.
func (s *ModelStore) Resolve(name string) string {
	if name == "" {
		return name
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	lower := strings.ToLower(strings.TrimSpace(name))
	if e, ok := s.byID[lower]; ok {
		return e.ID
	}
	if e, ok := s.byS[lower]; ok {
		return e.ID
	}
	return name
}

// List returns all registry entries (snapshot)
func (s *ModelStore) List() []ModelEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]ModelEntry, 0, len(s.byID))
	seen := map[string]bool{}
	for _, e := range s.byID {
		if seen[strings.ToLower(e.ID)] {
			continue
		}
		seen[strings.ToLower(e.ID)] = true
		out = append(out, *e)
	}
	return out
}

// Status returns the current sync status
func (s *ModelStore) Status() SyncStatus {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.status
}

func (s *ModelStore) refreshStatusLocked() {
	next := int64(-1)
	if s.intervalH > 0 && s.status.LastSync != "" {
		last, err := time.Parse(time.RFC3339, s.status.LastSync)
		if err == nil {
			due := last.Add(time.Duration(s.intervalH) * time.Hour)
			next = int64(time.Until(due).Seconds())
			if next < 0 {
				next = 0
			}
		}
	}
	s.status.SyncInterval = s.intervalH
	s.status.NextSyncIn = next
}

// SetSyncResult records a sync outcome and persists the registry
func (s *ModelStore) SetSyncResult(entries []ModelEntry, ok bool, msg string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.status.LastSync = time.Now().Format(time.RFC3339)
	s.status.LastCount = len(entries)
	if ok {
		s.status.LastResult = "ok"
		s.status.LastMessage = msg
	} else {
		s.status.LastResult = "error"
		s.status.LastMessage = msg
	}

	if ok && len(entries) > 0 {
		for i := range entries {
			e := &entries[i]
			if e.Source == "" {
				e.Source = "synced"
			}
			key := strings.ToLower(e.ID)
			if cur, exists := s.byID[key]; exists {
				cur.Vendor = e.Vendor
				cur.ShortName = e.ShortName
				cur.Name = e.Name
				cur.ContextWin = e.ContextWin
				cur.Source = "synced"
			} else {
				s.index(e)
			}
		}
		s.saveLocked()
	}
	s.refreshStatusLocked()
}

func (s *ModelStore) saveLocked() {
	list := make([]ModelEntry, 0, len(s.byID))
	seen := map[string]bool{}
	for _, e := range s.byID {
		if seen[strings.ToLower(e.ID)] {
			continue
		}
		seen[strings.ToLower(e.ID)] = true
		list = append(list, *e)
	}
	data, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(s.dataPath), 0o755); err != nil {
		return
	}
	if err := os.WriteFile(s.dataPath, data, 0o644); err != nil {
		log.Printf("[models] save failed: %v", err)
	}
}

// SetInterval updates the auto-sync interval (hours; 0 disables)
func (s *ModelStore) SetInterval(h int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.intervalH = h
	s.refreshStatusLocked()
}

// Due reports whether a periodic sync is due
func (s *ModelStore) Due() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.status.NextSyncIn == 0
}
