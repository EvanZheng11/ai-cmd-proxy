package models

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ProviderModelsResponse is the /provider/v1/models payload
type ProviderModelsResponse struct {
	Object string           `json:"object"`
	Data   []ProviderModel  `json:"data"`
}

// ProviderModel is one entry from the official provider models endpoint
type ProviderModel struct {
	ID            string `json:"id"`
	Object        string `json:"object"`
	Created       int64  `json:"created"`
	OwnedBy       string `json:"owned_by"`
	Name          string `json:"name"`
	ContextLength int64  `json:"context_length"`
}

// FetchModelList downloads the official provider models list.
// baseURL is the API root, e.g. https://api.commandcode.ai
func FetchModelList(baseURL string, apiKey string, timeout time.Duration) ([]ModelEntry, error) {
	if apiKey == "" {
		return nil, fmt.Errorf("需要 API Key 才能同步模型")
	}
	client := &http.Client{Timeout: timeout}
	req, err := http.NewRequest(http.MethodGet, strings.TrimRight(baseURL, "/")+"/provider/v1/models", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("User-Agent", "Mozilla/5.0 (ccproxy/2.0; model-sync)")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("models 端点返回 %d: %s", resp.StatusCode, truncateBytes(body))
	}

	var payload ProviderModelsResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&payload); err != nil {
		return nil, fmt.Errorf("解析模型列表失败: %w", err)
	}
	if len(payload.Data) == 0 {
		return nil, fmt.Errorf("模型列表为空")
	}

	entries := make([]ModelEntry, 0, len(payload.Data))
	for _, m := range payload.Data {
		short := m.ID
		if idx := strings.LastIndex(m.ID, "/"); idx >= 0 {
			short = m.ID[idx+1:]
		}
		name := m.Name
		if name == "" {
			name = short
		}
		entries = append(entries, ModelEntry{
			ID:         m.ID,
			Vendor:     m.OwnedBy,
			ShortName:  short,
			Name:       name,
			ContextWin: m.ContextLength,
			Source:     "synced",
		})
	}
	return entries, nil
}

func truncateBytes(b []byte) string {
	s := string(b)
	if len(s) > 300 {
		return s[:300]
	}
	return s
}
