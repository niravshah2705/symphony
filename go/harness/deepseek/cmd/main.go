// Command deepseek-runtime runs the DeepSeek Harness runtime adapter.
package main

import (
	"cmp"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	a2atype "github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2asrv"

	"github.com/niravshah2705/symphony/go/adk/pkg/app"
	"github.com/niravshah2705/symphony/go/adk/pkg/bootstrap"
	"github.com/niravshah2705/symphony/go/harness/deepseek/config"
	"github.com/niravshah2705/symphony/go/harness/deepseek/executor"
	"github.com/niravshah2705/symphony/go/pkg/logging"
	"github.com/niravshah2705/symphony/go/pkg/telemetry"
)

const (
	dataDir     = "/data"
	privatePort = "80"
)

func main() {
	check := flag.Bool("check", false, "validate configuration and CLI version, then exit")
	flag.Parse()
	logger, err := logging.New(os.Stderr, "info")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	ctx := logging.IntoContext(context.Background(), logger)
	if err := run(ctx, *check, os.Getenv, os.Environ()); err != nil {
		logger.ErrorContext(ctx, "deepseek harness stopped", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, check bool, getenv func(string) string, environment []string) error {
	bundle, err := bootstrap.FromEnvironment(ctx, getenv)
	if err != nil {
		return err
	}
	configJSON, agentCardJSON := bundle.ConfigJson, bundle.AgentCardJson
	var card a2atype.AgentCard
	if err := json.Unmarshal(agentCardJSON, &card); err != nil {
		return fmt.Errorf("decode agent card: %w", err)
	}
	if card.Name == "" {
		return fmt.Errorf("agent card name is required")
	}
	cfg, err := config.Parse(configJSON)
	if err != nil {
		return err
	}
	cfg.RuntimeTelemetry = cfg.RuntimeTelemetry.WithEnvironment(environment)
	logger, err := logging.New(os.Stderr, cmp.Or(cfg.LogLevel, "info"))
	if err != nil {
		return err
	}
	ctx = logging.IntoContext(ctx, logger)
	providers, err := telemetry.Init(ctx, telemetry.Options{
		Config:       cfg.RuntimeTelemetry.ExporterConfig(),
		Identity:     cfg.RuntimeTelemetry.ResourceIdentity(),
		Defaults:     cfg.RuntimeTelemetry.ResourceDefaults(card.Name),
		DeferMetrics: true,
	})
	if err != nil {
		logging.FromContext(ctx).ErrorContext(ctx, "failed to initialize harness telemetry", "error", err)
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := providers.Shutdown(shutdownCtx); err != nil {
			logging.FromContext(ctx).ErrorContext(ctx, "failed to shutdown harness telemetry", "error", err)
		}
	}()

	exec, closer, err := executor.New(ctx, executor.Config{ConfigJSON: configJSON, DataDir: dataDir, Environment: environment})
	if err != nil {
		return err
	}
	defer closer.Close()
	if check {
		return nil
	}
	application, err := app.New(app.AppConfig{
		AgentCard: card, Port: privatePort, AppName: card.Name, ControlPlaneURL: cfg.ControlPlaneURL,
		MaxContentLength: cfg.MaxContentLength, Logger: logging.FromContext(ctx),
		Telemetry: cfg.RuntimeTelemetry, Flush: providers.ForceFlush,
		HandlerOpts: []a2asrv.RequestHandlerOption{a2asrv.WithExecutorContextInterceptor(startMetrics(providers.StartMetrics))},
	}, exec)
	if err != nil {
		return fmt.Errorf("construct private A2A app: %w", err)
	}
	return application.Run()
}

// startMetrics starts metrics on the first execution, which runs after the snapshot restore.
type startMetrics func()

func (start startMetrics) Intercept(ctx context.Context, _ *a2asrv.ExecutorContext) (context.Context, error) {
	start()
	return ctx, nil
}
