// Package executor builds the DeepAgent Harness A2A executor for
// deepagent-runtime and for binaries that embed the harness elsewhere.
package executor

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/a2aproject/a2a-go/v2/a2asrv"

	"github.com/niravshah2705/symphony/go/harness/deepagent/config"
	"github.com/niravshah2705/symphony/go/harness/deepagent/internal/adapter"
	runtimea2a "github.com/niravshah2705/symphony/go/harness/runtime/a2a"
	"github.com/niravshah2705/symphony/go/harness/runtime/continuation"
)

// Config is the input to New.
type Config struct {
	// ConfigJSON is the compiler-owned bootstrap configuration document.
	ConfigJSON []byte
	// DataDir is the absolute durable directory; it is created if missing.
	DataDir string
	// Environment is the process environment passed to the deepagents-code CLI.
	Environment []string
}

// New validates the configuration and CLI installation, then returns the
// executor and the resource to close on shutdown.
func New(ctx context.Context, cfg Config) (a2asrv.AgentExecutor, io.Closer, error) {
	runner, err := adapter.New(ctx, adapter.Input{
		ConfigJSON:   cfg.ConfigJSON,
		Workspace:    cfg.DataDir + "/workspace",
		DurableDir:   cfg.DataDir,
		EphemeralDir: "/tmp/deepagent-runtime",
		Environment:  cfg.Environment,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("configure DeepAgent Harness: %w", err)
	}
	validateCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := runner.Validate(validateCtx); err != nil {
		_ = runner.Close()
		return nil, nil, err
	}
	store, err := continuation.New(cfg.DataDir+"/adapter", "deepagent", validateContinuationID)
	if err != nil {
		_ = runner.Close()
		return nil, nil, err
	}
	parsed, err := config.Parse(cfg.ConfigJSON)
	if err != nil {
		_ = runner.Close()
		return nil, nil, err
	}
	executor, err := runtimea2a.New(runner, store, parsed.RuntimeTelemetry)
	if err != nil {
		_ = runner.Close()
		return nil, nil, err
	}
	return executor, runner, nil
}

// validateContinuationID accepts any opaque non-empty native session identifier.
func validateContinuationID(id string) error {
	if id == "" {
		return fmt.Errorf("deepagent continuation ID must be non-empty")
	}
	return nil
}
