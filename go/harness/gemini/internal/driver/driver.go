// Package driver runs the native gemini CLI as a subprocess and maps
// its stdout stream onto the shared Harness runtime event model.
package driver

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/niravshah2705/symphony/go/harness/gemini/config"
	"github.com/niravshah2705/symphony/go/harness/internal/utils"
	"github.com/niravshah2705/symphony/go/harness/runtime"
)

// Config is the constructed driver input.
type Config struct {
	Runtime     config.Config
	Workspace   string
	Environment []string
}

// Driver implements runtime.Runner for the gemini CLI.
type Driver struct {
	runtime     config.Config
	workspace   string
	environment []string
}

// New returns a driver bound to the compiled configuration and Actor paths.
func New(cfg Config) *Driver {
	return &Driver{runtime: cfg.Runtime, workspace: cfg.Workspace, environment: cfg.Environment}
}

// Validate confirms the native CLI is installed and, when strict, at the pinned version.
func (d *Driver) Validate(ctx context.Context) error {
	checkCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	checkCmd := exec.CommandContext(checkCtx, d.runtime.Executable, "--version")
	checkCmd.Env = d.environment
	out, err := checkCmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("validate %s install: %w: %s", d.runtime.Executable, err, strings.TrimSpace(string(out)))
	}
	if d.runtime.StrictVersion && !strings.Contains(string(out), d.runtime.ExpectedVersion) {
		return fmt.Errorf("%s version mismatch: want %q, got %q",
			d.runtime.Executable, d.runtime.ExpectedVersion, strings.TrimSpace(string(out)))
	}
	return nil
}

// Args renders the CLI invocation for one turn. The prompt travels on stdin so
// large compiled instructions stay out of argv.
func (d *Driver) Args() []string {
	args := make([]string, 0, len(d.runtime.ExtraArgs)+2)
	args = append(args, d.runtime.ExtraArgs...)
	if model := strings.TrimSpace(d.runtime.Model); model != "" {
		args = append(args, "--model", model)
	}
	if sp := strings.TrimSpace(d.runtime.SystemPrompt); sp != "" {
		args = append(args, "--system-prompt", sp)
	}
	return args
}

// Run launches the CLI, streams assistant text, and returns a terminal Outcome.
//
// NOTE: gemini has no confirmed machine-readable event protocol, so this is a
// documented bounded passthrough: each stdout line becomes a TextDelta and the
// process exit status selects the Outcome. Grow this driver with real
// ToolCall/ToolResult/ModelCall mapping once the CLI's streaming shape is
// confirmed; do not fabricate an event contract.
func (d *Driver) Run(ctx context.Context, turn runtime.Turn, sink runtime.EventSink) (runtime.Outcome, error) {
	if strings.TrimSpace(turn.Prompt) == "" {
		return runtime.Outcome{}, errors.New("gemini prompt is required")
	}
	continuationID := turn.ContinuationID
	if continuationID == "" {
		continuationID = uuid.NewString()
	}
	if err := sink.SessionStarted(runtime.SessionStarted{ContinuationID: continuationID}); err != nil {
		return runtime.Outcome{}, err
	}

	cmd := exec.CommandContext(ctx, d.runtime.Executable, d.Args()...)
	utils.ConfigureProcessGroup(cmd)
	cmd.Dir = d.workspace
	cmd.Env = d.environment
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return runtime.Outcome{}, fmt.Errorf("open gemini stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return runtime.Outcome{}, fmt.Errorf("open gemini stdout: %w", err)
	}
	stderr := utils.NewBoundedBuffer(d.runtime.MaxStderrBytes)
	cmd.Stderr = stderr

	if err := cmd.Start(); err != nil {
		return runtime.Outcome{}, fmt.Errorf("start gemini: %w", err)
	}
	go func() {
		_, _ = io.WriteString(stdin, turn.Prompt)
		_ = stdin.Close()
	}()

	streamErr := error(nil)
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), d.runtime.MaxEventBytes)
	for scanner.Scan() {
		if err := sink.TextDelta(runtime.TextDelta{Text: scanner.Text() + "\n"}); err != nil {
			streamErr = err
			break
		}
	}
	readErr := scanner.Err()

	waitErr := cmd.Wait()

	switch {
	case streamErr != nil:
		return runtime.Outcome{}, streamErr
	case ctx.Err() != nil:
		return runtime.Outcome{}, ctx.Err()
	case readErr != nil:
		return runtime.Outcome{}, fmt.Errorf("read gemini stdout: %w", readErr)
	case waitErr != nil:
		return runtime.Outcome{Failure: &runtime.Failure{
			Message: fmt.Sprintf("%s exited with an error: %v: %s", d.runtime.Executable, waitErr, stderr.String()),
		}}, nil
	default:
		return runtime.Outcome{}, nil
	}
}

// Close is a no-op; the driver owns no persistent resources between turns.
func (d *Driver) Close() error { return nil }
