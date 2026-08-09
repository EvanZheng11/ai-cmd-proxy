package server

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/hayou2002/command-code-proxy/internal/config"
	"github.com/hayou2002/command-code-proxy/internal/keypool"
	"github.com/hayou2002/command-code-proxy/internal/models"
	"github.com/hayou2002/command-code-proxy/internal/proxy"
)

const defaultPort = "55990"
const defaultHost = "0.0.0.0"

// Server represents the HTTP server
type Server struct {
	Port    string
	Host    string
	Proxy   *proxy.Proxy
	Config  *config.Config
	Keys    *keypool.KeyManager
	Models  *models.ModelStore
	Handler http.Handler

	ModelSyncFunc func() ([]models.ModelEntry, error)
	startedAt     time.Time
}

// NewServer creates a new server instance
func NewServer(p *proxy.Proxy, cfg *config.Config, keys *keypool.KeyManager, ms *models.ModelStore) *Server {
	s := &Server{
		Port:      cfg.Port,
		Host:      cfg.Host,
		Proxy:     p,
		Config:    cfg,
		Keys:      keys,
		Models:    ms,
		startedAt: time.Now(),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/chat/completions", logger(p.HandleChatCompletions))
	mux.HandleFunc("/chat/completions", logger(p.HandleChatCompletions))
	mux.HandleFunc("/v1/responses", logger(p.HandleResponses))
	mux.HandleFunc("/v1/models", logger(p.HandleModels))
	mux.HandleFunc("/health", logger(s.handleHealth))

	// Admin panel & API
	mux.HandleFunc("/", s.handleRoot)
	mux.HandleFunc("/api/keys", s.handleKeys)
	mux.HandleFunc("/api/keys/", s.handleKeyAction)
	mux.HandleFunc("/api/health", s.handleHealthCheck)
	mux.HandleFunc("/api/test-key", s.handleTestKey)
	mux.HandleFunc("/api/models", s.handleModelsInfo)
	mux.HandleFunc("/api/models/sync", s.handleModelSync)
	mux.HandleFunc("/api/stats", s.handleStats)
	mux.HandleFunc("/api/config", s.handleConfig)

	s.Handler = mux
	return s
}

func (s *Server) handleRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(panelHTML))
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"status":  "ok",
		"uptime":  time.Since(s.startedAt).Seconds(),
		"version": "2.0.0",
	})
}

// ─── Key management API ──────────────────────────────────────────

func (s *Server) handleKeys(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		all := s.Keys.AllKeys()
		dicts := make([]map[string]any, 0, len(all))
		for _, k := range all {
			dicts = append(dicts, k.ToDict())
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"keys":  dicts,
			"stats": s.Keys.Stats(),
		})
	case http.MethodPost:
		var req struct {
			Key  string `json:"key"`
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			httpError(w, 400, "Invalid JSON")
			return
		}
		req.Key = strings.TrimSpace(req.Key)
		if req.Key == "" {
			httpError(w, 400, "Key 不能为空")
			return
		}
		apiKey, err := s.Keys.AddKey(req.Key, strings.TrimSpace(req.Name))
		if err != nil {
			httpError(w, 400, err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "key": apiKey.ToDict()})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleKeyAction(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimPrefix(r.URL.Path, "/api/keys/")
	key = strings.TrimSpace(key)
	if key == "" {
		httpError(w, 400, "Key 不能为空")
		return
	}
	switch r.Method {
	case http.MethodPut:
		apiKey := s.Keys.ToggleKey(key)
		if apiKey == nil {
			httpError(w, 404, "Key 不存在")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "key": apiKey.ToDict()})
	case http.MethodDelete:
		if s.Keys.RemoveKey(key) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"ok": true})
			return
		}
		httpError(w, 404, "Key 不存在")
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

// ─── Health check ────────────────────────────────────────────────

// testSingleKey probes one upstream key with a minimal request.
// Direct upstream only (never through relay channels).
func (s *Server) testSingleKey(key string) map[string]any {
	start := time.Now()
	testBody := fmt.Sprintf(`{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":1,"stream":false}`)

	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(s.Proxy.BaseURL, "/")+"/provider/v1/chat/completions",
		strings.NewReader(testBody))
	if err != nil {
		return map[string]any{"status": "error", "latency_ms": 0, "code": 0, "detail": err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("User-Agent", "ccproxy/2.0")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	latency := int(time.Since(start).Milliseconds())
	if err != nil {
		return map[string]any{"status": "error", "latency_ms": latency, "code": 0, "detail": err.Error()}
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		return map[string]any{"status": "ok", "latency_ms": latency, "code": 200}
	case http.StatusTooManyRequests:
		msg := readLimited(resp, 200)
		detail := ""
		if strings.Contains(strings.ToLower(msg), "limit") {
			detail = "已达窗口限额"
		}
		return map[string]any{"status": "rate_limited", "latency_ms": latency, "code": 429, "detail": detail}
	case http.StatusUnauthorized, http.StatusForbidden:
		return map[string]any{"status": "auth_error", "latency_ms": latency, "code": resp.StatusCode}
	default:
		return map[string]any{"status": "error", "latency_ms": latency, "code": resp.StatusCode, "detail": readLimited(resp, 200)}
	}
}

func (s *Server) handleHealthCheck(w http.ResponseWriter, r *http.Request) {
	keys := s.Keys.AllKeys()
	results := make([]map[string]any, 0, len(keys))
	for _, k := range keys {
		if !k.Enabled {
			results = append(results, map[string]any{
				"name": k.Name, "key": k.ShortKeyForPanel(),
				"status": "disabled", "latency_ms": 0, "code": 0,
			})
			continue
		}
		res := s.testSingleKey(k.Key)
		res["name"] = k.Name
		res["key"] = k.ShortKeyForPanel()

		// apply outcome to pool
		if res["status"] == "ok" {
			s.Keys.MarkSuccess(k.Key)
		} else if res["status"] == "rate_limited" {
			if strings.Contains(fmt.Sprint(res["detail"]), "限额") {
				s.Keys.MarkDisabledByQuota(k.Key, "5h_quota")
			} else {
				s.Keys.MarkError(k.Key, "health probe 429")
			}
		} else if res["status"] == "auth_error" {
			s.Keys.MarkError(k.Key, "health probe auth error")
		}
		results = append(results, res)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"results": results})
}

func (s *Server) handleTestKey(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Key string `json:"key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpError(w, 400, "Invalid JSON")
		return
	}
	if strings.TrimSpace(req.Key) == "" {
		httpError(w, 400, "Key 不能为空")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(s.testSingleKey(req.Key))
}

// ─── Models API ──────────────────────────────────────────────────

func (s *Server) handleModelsInfo(w http.ResponseWriter, r *http.Request) {
	entries := s.Models.List()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"models": entries,
		"status": s.Models.Status(),
	})
}

func (s *Server) handleModelSync(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if s.ModelSyncFunc == nil {
		httpError(w, 500, "模型同步未配置")
		return
	}
	entries, err := s.ModelSyncFunc()
	if err != nil {
		s.Models.SetSyncResult(nil, false, err.Error())
		httpError(w, 502, "同步失败: "+err.Error())
		return
	}
	s.Models.SetSyncResult(entries, true, fmt.Sprintf("从文档同步 %d 个模型", len(entries)))
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"ok":     true,
		"count":  len(entries),
		"status": s.Models.Status(),
	})
}

// ─── Stats & config ──────────────────────────────────────────────

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"keys":         s.Keys.Stats(),
		"models_count": len(s.Models.List()),
		"model_status": s.Models.Status(),
		"uptime":       time.Since(s.startedAt).Seconds(),
	})
}

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		cfg := s.Config.Get()
		cfg.Dir = ""
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(cfg)
	case http.MethodPut:
		var m map[string]any
		if err := json.NewDecoder(r.Body).Decode(&m); err != nil {
			httpError(w, 400, "Invalid JSON")
			return
		}
		s.Config.Update(m)
		_ = s.Config.Save()
		// propagate interval change to model store
		if v, ok := m["sync_interval_hours"].(float64); ok {
			s.Models.SetInterval(int(v))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

// ScanAndRestoreKeys probes quota-disabled keys periodically and restores
// any that respond 200. Direct upstream only (probe traffic never routes
// through relay channels). Returns count of restored keys.
func (s *Server) ScanAndRestoreKeys() int {
	restored := 0
	for _, k := range s.Keys.AllKeys() {
		if k.DisabledReason == "" || k.DisabledReason == "manual" || !k.Enabled {
			continue
		}
		res := s.testSingleKey(k.Key)
		if res["status"] == "ok" {
			if s.Keys.RestoreKey(k.Key) != nil {
				restored++
			}
		}
	}
	return restored
}

// SetSyncResult records a successful sync (used by background scheduler)
func (s *Server) SetSyncResult(entries []models.ModelEntry) {
	s.Models.SetSyncResult(entries, true, fmt.Sprintf("从文档同步 %d 个模型", len(entries)))
}

// SetSyncError records a failed sync
func (s *Server) SetSyncError(msg string) {
	s.Models.SetSyncResult(nil, false, msg)
}

// ─── helpers ─────────────────────────────────────────────────────

func httpError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"error": msg})
}

func readLimited(resp *http.Response, n int) string {
	buf := make([]byte, n)
	read, _ := resp.Body.Read(buf)
	return string(buf[:read])
}

// logger is a middleware for logging requests
func logger(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next(w, r)
		log.Printf("[%s] %s %s in %v", r.Method, r.URL.Path, r.RemoteAddr, time.Since(start))
	}
}

// SetPort sets the port for the server
func (s *Server) SetPort(port string) {
	if port != "" {
		s.Port = port
	}
}

// SetHost sets the host for the server
func (s *Server) SetHost(host string) {
	if host != "" {
		s.Host = host
	}
}

// GetPort returns the server port
func (s *Server) GetPort() string {
	return s.Port
}

// GetHost returns the server host
func (s *Server) GetHost() string {
	return s.Host
}

// Start starts the HTTP server
func (s *Server) Start() {
	addr := s.Host + ":" + s.Port
	log.Printf("ccproxy v2 listening on http://%s (panel: http://%s/)", addr, addr)
	if err := http.ListenAndServe(addr, s.Handler); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
