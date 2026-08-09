package proxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/hayou2002/command-code-proxy/internal/api"
	"github.com/hayou2002/command-code-proxy/internal/keypool"
	"github.com/hayou2002/command-code-proxy/internal/models"
)

const defaultTimeout = 300 * time.Second
const debugLogLimit = 20000

func safeKeyPrefix(key string) string {
	if len(key) <= 8 {
		return "***"
	}
	return key[:8] + "..."
}

func truncateLog(s string) string {
	if len(s) <= debugLogLimit {
		return s
	}
	return s[:debugLogLimit] + fmt.Sprintf("... [truncated %d bytes]", len(s)-debugLogLimit)
}

func (p *Proxy) debugf(format string, args ...any) {
	if p.Debug {
		log.Printf(format, args...)
	}
}

func (p *Proxy) writeOpenAIError(w http.ResponseWriter, status int, message, errType string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(api.OpenAIErrorResponse{Error: api.OpenAIError{
		Message: message,
		Type:    errType,
		Param:   nil,
		Code:    nil,
	}})
}

// Proxy is the OpenAI-compatible proxy to CommandCode Provider API
type Proxy struct {
	BaseURL string
	Client  *http.Client
	Debug   bool
	Keys    *keypool.KeyManager
	Models  *models.ModelStore
}

// NewProxy creates a new proxy instance
func NewProxy(baseURL string, keys *keypool.KeyManager, models *models.ModelStore) *Proxy {
	if baseURL == "" {
		baseURL = "https://api.commandcode.ai"
	}
	return &Proxy{
		BaseURL: baseURL,
		Client:  &http.Client{Timeout: defaultTimeout},
		Keys:    keys,
		Models:  models,
	}
}

// upstreamURL returns the provider chat completions endpoint
func (p *Proxy) upstreamURL() string {
	return strings.TrimRight(p.BaseURL, "/") + "/provider/v1/chat/completions"
}

// buildUpstreamBody maps the model to a full upstream id and re-marshals
func (p *Proxy) buildUpstreamBody(openAIReq api.OpenAIChatRequest) ([]byte, error) {
	// Model resolution: short name -> full id (provider API requires full id)
	mapped := p.Models.Resolve(openAIReq.Model)
	if mapped != openAIReq.Model {
		openAIReq.Model = mapped
	}
	return json.Marshal(openAIReq)
}

// HandleChatCompletions handles the /v1/chat/completions endpoint
func (p *Proxy) HandleChatCompletions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		p.writeOpenAIError(w, http.StatusMethodNotAllowed, "Method not allowed", "invalid_request_error")
		return
	}

	// Read client request
	body, err := io.ReadAll(r.Body)
	if err != nil {
		p.writeOpenAIError(w, http.StatusBadRequest, "Failed to read body", "invalid_request_error")
		return
	}
	p.debugf("[DEBUG] Client request body: %s", truncateLog(string(body)))

	var openAIReq api.OpenAIChatRequest
	if err := json.Unmarshal(body, &openAIReq); err != nil {
		p.writeOpenAIError(w, http.StatusBadRequest, fmt.Sprintf("Invalid JSON: %s", err.Error()), "invalid_request_error")
		return
	}
	if len(openAIReq.Messages) == 0 {
		p.writeOpenAIError(w, http.StatusBadRequest, "messages array is required", "invalid_request_error")
		return
	}

	upBody, err := p.buildUpstreamBody(openAIReq)
	if err != nil {
		p.writeOpenAIError(w, http.StatusInternalServerError, "Failed to build request", "server_error")
		return
	}
	p.debugf("[DEBUG] Upstream request body: %s", truncateLog(string(upBody)))

	// Pick an available key
	apiKey := p.Keys.GetNext()
	if apiKey == nil {
		p.writeOpenAIError(w, http.StatusTooManyRequests,
			"所有 Key 均不可用（冷却/限额/禁用），请稍后重试", "rate_limit_error")
		return
	}
	p.debugf("[DEBUG] Using API key: %s (%s)", apiKey.Name, safeKeyPrefix(apiKey.Key))

	// Call upstream; retry once with next key on 429
	ccResp, usedKey, err := p.callUpstreamWithRetry(r.Context(), upBody, apiKey)
	if err != nil {
		p.writeOpenAIError(w, http.StatusBadGateway, err.Error(), "api_error")
		return
	}
	defer ccResp.Body.Close()

	if ccResp.StatusCode == http.StatusTooManyRequests {
		errBody, _ := io.ReadAll(ccResp.Body)
		p.writeOpenAIError(w, http.StatusTooManyRequests,
			"所有 Key 均被限流，请稍后重试: "+truncateLog(string(errBody)), "rate_limit_error")
		return
	}

	if ccResp.StatusCode != http.StatusOK {
		errBody, _ := io.ReadAll(ccResp.Body)
		message := fmt.Sprintf("Upstream error: %s", truncateLog(string(errBody)))
		log.Printf("[ERROR] Upstream returned %d: %s", ccResp.StatusCode, truncateLog(string(errBody)))
		status := http.StatusBadGateway
		if ccResp.StatusCode >= http.StatusBadRequest && ccResp.StatusCode < http.StatusInternalServerError {
			status = ccResp.StatusCode
		}
		if ccResp.StatusCode == http.StatusUnauthorized || ccResp.StatusCode == http.StatusForbidden {
			p.Keys.MarkError(usedKey.Key, fmt.Sprintf("%d auth error", ccResp.StatusCode))
		}
		p.writeOpenAIError(w, status, message, "api_error")
		return
	}

	p.Keys.MarkSuccess(usedKey.Key)

	if openAIReq.Stream {
		p.streamPassThrough(w, r, ccResp, openAIReq.Model)
	} else {
		p.nonStreamPassThrough(w, ccResp, openAIReq.Model)
	}
}

// callUpstreamWithRetry posts to the provider endpoint; on 429 it marks the key,
// then retries once with the next available key.
func (p *Proxy) callUpstreamWithRetry(ctx context.Context, body []byte, first *keypool.ApiKey) (*http.Response, *keypool.ApiKey, error) {
	req, err := p.buildUpstreamRequest(ctx, body, first.Key)
	if err != nil {
		return nil, nil, err
	}
	resp, err := p.Client.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("upstream error: %w", err)
	}

	if resp.StatusCode != http.StatusTooManyRequests {
		return resp, first, nil
	}

	// mark first key, try next
	errBody, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	p.Keys.MarkError(first.Key, fmt.Sprintf("429 rate limited: %s", truncateLog(string(errBody))))

	next := p.Keys.GetNext()
	if next == nil || next.Key == first.Key {
		return &http.Response{StatusCode: http.StatusTooManyRequests, Body: io.NopCloser(bytes.NewReader(errBody))}, first, nil
	}
	p.debugf("[DEBUG] key %s 429, retrying with %s", first.Name, next.Name)
	req2, err := p.buildUpstreamRequest(ctx, body, next.Key)
	if err != nil {
		return &http.Response{StatusCode: http.StatusTooManyRequests, Body: io.NopCloser(bytes.NewReader(errBody))}, first, nil
	}
	resp2, err := p.Client.Do(req2)
	if err != nil {
		return nil, nil, fmt.Errorf("upstream error: %w", err)
	}
	return resp2, next, nil
}

func (p *Proxy) buildUpstreamRequest(ctx context.Context, body []byte, apiKey string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.upstreamURL(), bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create upstream request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("User-Agent", "ccproxy/2.0")
	return req, nil
}

// streamPassThrough relays SSE chunks verbatim, mapping upstream `reasoning`
// deltas to `reasoning_content` for broader client compatibility.
func (p *Proxy) streamPassThrough(w http.ResponseWriter, r *http.Request, upResp *http.Response, clientModel string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		p.writeOpenAIError(w, http.StatusInternalServerError, "Streaming not supported", "server_error")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	scanner := bufio.NewScanner(upResp.Body)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)

	for scanner.Scan() {
		select {
		case <-r.Context().Done():
			return
		default:
		}
		line := scanner.Text()
		if line == "" {
			continue
		}
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "data:") || strings.Contains(trimmed, "[DONE]") {
			// meta/comment lines pass through as-is
			fmt.Fprintln(w, line)
			flusher.Flush()
			continue
		}

		payload := strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
		var chunk map[string]any
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			fmt.Fprintln(w, line)
			flusher.Flush()
			continue
		}

		// map delta.reasoning -> delta.reasoning_content
		if clientModel != "" {
			chunk["model"] = clientModel
		}
		if choices, ok := chunk["choices"].([]any); ok {
			for _, c := range choices {
				cm, ok := c.(map[string]any)
				if !ok {
					continue
				}
				delta, ok := cm["delta"].(map[string]any)
				if !ok {
					continue
				}
				if reasoning, ok := delta["reasoning"]; ok {
					if _, exists := delta["reasoning_content"]; !exists {
						delta["reasoning_content"] = reasoning
					}
				}
				// also handle reasoning_details -> keep as-is (already present)
			}
		}

		out, err := json.Marshal(chunk)
		if err != nil {
			fmt.Fprintln(w, line)
			flusher.Flush()
			continue
		}
		fmt.Fprintf(w, "data: %s\n\n", out)
		flusher.Flush()
	}
}

// nonStreamPassThrough relays the JSON body, mapping message.reasoning to reasoning_content
func (p *Proxy) nonStreamPassThrough(w http.ResponseWriter, upResp *http.Response, clientModel string) {
	body, err := io.ReadAll(upResp.Body)
	if err != nil {
		p.writeOpenAIError(w, http.StatusBadGateway, "failed to read upstream", "api_error")
		return
	}

	var resp map[string]any
	if json.Unmarshal(body, &resp) == nil {
		if clientModel != "" {
			resp["model"] = clientModel
		}
		if choices, ok := resp["choices"].([]any); ok {
			for _, c := range choices {
				cm, ok := c.(map[string]any)
				if !ok {
					continue
				}
				msg, ok := cm["message"].(map[string]any)
				if !ok {
					continue
				}
				if reasoning, ok := msg["reasoning"]; ok {
					if _, exists := msg["reasoning_content"]; !exists {
						msg["reasoning_content"] = reasoning
					}
				}
			}
			if out, err := json.Marshal(resp); err == nil {
				body = out
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(upResp.StatusCode)
	w.Write(body)
}

// HandleResponses converts an OpenAI Responses-API request to chat format and proxies it
func (p *Proxy) HandleResponses(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		p.writeOpenAIError(w, http.StatusMethodNotAllowed, "Method not allowed", "invalid_request_error")
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		p.writeOpenAIError(w, http.StatusBadRequest, "Failed to read body", "invalid_request_error")
		return
	}
	p.debugf("[DEBUG] Client responses request body: %s", truncateLog(string(body)))

	var responsesReq api.OpenAIResponsesRequest
	if err := json.Unmarshal(body, &responsesReq); err != nil {
		p.writeOpenAIError(w, http.StatusBadRequest, fmt.Sprintf("Invalid JSON: %s", err.Error()), "invalid_request_error")
		return
	}

	chatReq := responsesToChatRequest(responsesReq)
	rewritten, err := json.Marshal(chatReq)
	if err != nil {
		p.writeOpenAIError(w, http.StatusInternalServerError, "Failed to build request", "server_error")
		return
	}

	r.Body = io.NopCloser(bytes.NewReader(rewritten))
	r.ContentLength = int64(len(rewritten))
	p.HandleChatCompletions(w, r)
}

func responsesToChatRequest(req api.OpenAIResponsesRequest) api.OpenAIChatRequest {
	messages := responsesInputToMessages(req.Input)
	if req.Instructions != nil {
		messages = append([]api.OpenAIMessage{{Role: "system", Content: req.Instructions}}, messages...)
	}

	maxTokens := req.MaxCompletionTokens
	if maxTokens == nil {
		maxTokens = req.MaxOutputTokens
	}
	if maxTokens == nil {
		maxTokens = req.MaxTokens
	}

	return api.OpenAIChatRequest{
		Model:               req.Model,
		Messages:            messages,
		Temperature:         req.Temperature,
		MaxTokens:           req.MaxTokens,
		MaxCompletionTokens: maxTokens,
		Stream:              req.Stream,
		Tools:               req.Tools,
		ToolChoice:          req.ToolChoice,
		ParallelToolCalls:   req.ParallelToolCalls,
		ResponseFormat:      req.ResponseFormat,
		Stop:                req.Stop,
		TopP:                req.TopP,
		User:                req.User,
	}
}

func responsesInputToMessages(input any) []api.OpenAIMessage {
	switch v := input.(type) {
	case nil:
		return nil
	case string:
		return []api.OpenAIMessage{{Role: "user", Content: v}}
	case []any:
		if messages := responseItemsToMessages(v); len(messages) > 0 {
			return messages
		}
		return []api.OpenAIMessage{{Role: "user", Content: v}}
	default:
		return []api.OpenAIMessage{{Role: "user", Content: v}}
	}
}

func responseItemsToMessages(items []any) []api.OpenAIMessage {
	messages := make([]api.OpenAIMessage, 0, len(items))
	for _, item := range items {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		role, _ := m["role"].(string)
		if role == "" {
			role = "user"
		}
		content := m["content"]
		if content == nil {
			content = m["text"]
		}
		if content == nil {
			content = m["input"]
		}
		messages = append(messages, api.OpenAIMessage{Role: role, Content: content})
	}
	return messages
}

// HandleModels returns the dynamic model list (short names for clients)
func (p *Proxy) HandleModels(w http.ResponseWriter, r *http.Request) {
	entries := p.Models.List()
	data := make([]api.OpenAIModel, 0, len(entries))
	for _, e := range entries {
		data = append(data, api.OpenAIModel{
			ID:      e.ShortName,
			Object:  "model",
			Created: 0,
			OwnedBy: e.Vendor,
		})
	}
	models := api.OpenAIModelList{Object: "list", Data: data}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(models)
}

var _ = uuid.New // keep uuid import for future use
