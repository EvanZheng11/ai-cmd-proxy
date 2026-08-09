package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/hayou2002/command-code-proxy/internal/config"
	"github.com/hayou2002/command-code-proxy/internal/keypool"
	"github.com/hayou2002/command-code-proxy/internal/models"
	"github.com/hayou2002/command-code-proxy/internal/proxy"
	"github.com/hayou2002/command-code-proxy/internal/server"
)

const appVersion = "v2.0.0"

func main() {
	dataDir := flag.String("data-dir", "", "数据目录（config/keys/models，默认 ./data）")
	port := flag.String("port", "", "监听端口（覆盖 config.json）")
	host := flag.String("host", "", "监听地址（覆盖 config.json）")
	apiKey := flag.String("api-key", "", "CommandCode API Key（首次启动自动写入 Key 池）")
	debug := flag.Bool("debug", false, "启用调试日志")
	showVersion := flag.Bool("version", false, "显示版本号")
	flag.Parse()

	if *showVersion {
		fmt.Println(appVersion)
		return
	}

	// data dir
	if *dataDir == "" {
		exe, err := os.Executable()
		if err == nil {
			*dataDir = filepath.Join(filepath.Dir(exe), "data")
		} else {
			*dataDir = "data"
		}
	}
	if err := os.MkdirAll(*dataDir, 0o755); err != nil {
		log.Fatalf("无法创建数据目录: %v", err)
	}

	// config
	cfg, err := config.Load(*dataDir)
	if err != nil {
		log.Fatalf("配置加载失败: %v", err)
	}
	if *port != "" {
		cfg.Port = *port
	}
	if *host != "" {
		cfg.Host = *host
	}
	if *debug {
		cfg.Debug = true
	}

	// key pool
	ad := keypool.AutoDisableConfig{
		Enabled:                  cfg.AutoDisable.Enabled,
		CooldownRecoverThreshold: cfg.AutoDisable.CooldownRecoverThreshold,
		ErrorRateThreshold:       cfg.AutoDisable.ErrorRateThreshold,
		ErrorRateMinSamples:      cfg.AutoDisable.ErrorRateMinSamples,
	}
	keys := keypool.NewKeyManager(*dataDir, cfg.GetCooldownSeconds(), ad)

	// auto-provision a key from -api-key or env (only if pool is empty)
	if len(keys.AllKeys()) == 0 {
		key := *apiKey
		if key == "" {
			key = os.Getenv("CC_API_KEY")
		}
		if key != "" {
			if _, err := keys.AddKey(key, "默认 Key"); err != nil {
				log.Printf("初始化 Key 失败: %v", err)
			}
		}
	}

	// model store
	ms := models.NewModelStore(*dataDir, cfg.SyncIntervalH)

	// proxy + server
	p := proxy.NewProxy(cfg.UpstreamBase, keys, ms)
	p.Debug = cfg.Debug

	srv := server.NewServer(p, cfg, keys, ms)
	srv.ModelSyncFunc = func() ([]models.ModelEntry, error) {
		// model sync uses the first available key for auth
		k := keys.GetNext()
		if k == nil {
			return nil, fmt.Errorf("没有可用 Key，无法同步模型")
		}
		return models.FetchModelList(cfg.UpstreamBase, k.Key, 30*time.Second)
	}
	srv.SetPort(cfg.Port)
	srv.SetHost(cfg.Host)

	// background: model sync (immediate once, then on interval)
	go func() {
		// first sync shortly after start (don't block boot)
		time.Sleep(3 * time.Second)
		syncModelsOnce(srv, cfg, keys)
		ticker := time.NewTicker(15 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			if ms.Due() {
				syncModelsOnce(srv, cfg, keys)
			}
		}
	}()

	// background: key restore scan (every 30 min)
	go func() {
		ticker := time.NewTicker(30 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			n := srv.ScanAndRestoreKeys()
			if n > 0 {
				log.Printf("[keypool] 恢复扫描：%d 个 Key 已自动恢复", n)
			}
		}
	}()

	// graceful shutdown
	go func() {
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
		<-ch
		log.Println("收到退出信号，保存状态...")
		keys.Flush()
		_ = cfg.Save()
		os.Exit(0)
	}()

	printStartupInfo(srv, *dataDir, len(keys.AllKeys()), len(ms.List()))
	srv.Start()
}

func syncModelsOnce(srv *server.Server, cfg *config.Config, keys *keypool.KeyManager) {
	log.Println("[models] 开始同步模型列表...")
	k := keys.GetNext()
	if k == nil {
		srv.SetSyncError("没有可用 Key，无法同步模型")
		return
	}
	entries, err := models.FetchModelList(cfg.UpstreamBase, k.Key, 30*time.Second)
	if err != nil {
		log.Printf("[models] 同步失败: %v", err)
		srv.SetSyncError(err.Error())
		return
	}
	srv.SetSyncResult(entries)
	log.Printf("[models] 同步完成：%d 个模型", len(entries))
}

func printStartupInfo(srv *server.Server, dataDir string, keyCount, modelCount int) {
	fmt.Println("")
	fmt.Println("========================================")
	fmt.Println("  CommandCode Proxy v2 (Multi-Key + Panel)")
	fmt.Println("========================================")
	fmt.Printf("  Version:    %s\n", appVersion)
	fmt.Printf("  Listen:     %s:%s\n", srv.GetHost(), srv.GetPort())
	fmt.Printf("  Data dir:   %s\n", dataDir)
	fmt.Printf("  API keys:   %d (面板可管理)\n", keyCount)
	fmt.Printf("  Models:     %d (自动同步)\n", modelCount)
	fmt.Println("")
	fmt.Println("  Endpoints:")
	fmt.Println("    POST /v1/chat/completions  (OpenAI-compatible)")
	fmt.Println("    POST /v1/responses         (Responses API)")
	fmt.Println("    GET  /v1/models            (dynamic model list)")
	fmt.Println("    GET  /                     (管理面板)")
	fmt.Println("    GET  /health               (health check)")
	fmt.Println("")
	fmt.Printf("  面板地址: http://%s:%s/\n", srv.GetHost(), srv.GetPort())
	fmt.Println("========================================")
}

