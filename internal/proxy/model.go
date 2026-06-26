package proxy

import "strings"

// Map model name if client sends short name
func MapModel(name string) string {
	switch strings.ToLower(name) {
	// DeepSeek
	case "deepseek-v4-pro", "deepseek-v4", "deepseek-pro":
		return "deepseek/deepseek-v4-pro"
	case "deepseek-v4-flash", "deepseek-flash":
		return "deepseek/deepseek-v4-flash"
	// Kimi (MoonshotAI)
	case "kimi-k2.7-code", "kimi2.7-code":
		return "moonshotai/Kimi-K2.7-Code"
	case "kimi-k2.7-code-highspeed", "kimi2.7-highspeed", "kimi-k2.7-highspeed":
		return "moonshotai/Kimi-K2.7-Code-Highspeed"
	case "kimi-k2.6", "kimi2.6":
		return "moonshotai/Kimi-K2.6"
	case "kimi-k2.5", "kimi2.5", "kimi":
		return "moonshotai/Kimi-K2.5"
	// ZhipuAI (GLM)
	case "glm-5.2":
		return "zai-org/GLM-5.2"
	case "glm-5.2-fast":
		return "zai-org/GLM-5.2-Fast"
	case "glm-5.1":
		return "zai-org/GLM-5.1"
	case "glm-5":
		return "zai-org/GLM-5"
	// MiniMax
	case "minimax-m3", "minimax3":
		return "MiniMaxAI/MiniMax-M3"
	case "minimax-m2.7", "minimax2.7":
		return "MiniMaxAI/MiniMax-M2.7"
	case "minimax-m2.5", "minimax2.5", "minimax":
		return "MiniMaxAI/MiniMax-M2.5"
	// Xiaomi (MiMo)
	case "mimo-v2.5-pro", "mimo2.5-pro":
		return "xiaomi/mimo-v2.5-pro"
	case "mimo-v2.5", "mimo2.5":
		return "xiaomi/mimo-v2.5"
	// Qwen
	case "qwen-3.7-max", "qwen3.7-max":
		return "Qwen/Qwen3.7-Max"
	case "qwen-3.7-plus", "qwen3.7-plus", "qwen3.7":
		return "Qwen/Qwen3.7-Plus"
	case "qwen-3.6-max-preview", "qwen3.6-max":
		return "Qwen/Qwen3.6-Max-Preview"
	case "qwen-3.6-plus", "qwen3.6-plus", "qwen3.6":
		return "Qwen/Qwen3.6-Plus"
	// StepFun
	case "step-3.7-flash", "step3.7":
		return "stepfun/Step-3.7-Flash"
	case "step-3.5-flash", "step3.5", "step":
		return "stepfun/Step-3.5-Flash"
	// NVIDIA
	case "nemotron-3-ultra", "nemotron3", "nemotron":
		return "nvidia/nemotron-3-ultra-550b-a55b"
	default:
		return name // pass through as-is
	}
}
