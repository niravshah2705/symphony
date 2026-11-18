package driver

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/niravshah2705/symphony/go/harness/kilo/config"
	"github.com/niravshah2705/symphony/go/harness/runtime"
)

// recordingSink captures the events a driver emits during one turn.
type recordingSink struct {
	session string
	text    strings.Builder
}

func (s *recordingSink) SessionStarted(e runtime.SessionStarted) error {
	s.session = e.ContinuationID
	return nil
}
func (s *recordingSink) TextDelta(e runtime.TextDelta) error { s.text.WriteString(e.Text); return nil }
func (s *recordingSink) ToolCall(runtime.ToolCall) error     { return nil }
func (s *recordingSink) ToolResult(runtime.ToolResult) error { return nil }
func (s *recordingSink) ModelCall(runtime.ModelCall)         {}

func stubCLI(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "cli.sh")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestRunStreamsStdoutAndSucceeds(t *testing.T) {
	cli := stubCLI(t, `cat >/dev/null; printf 'hello\nworld\n'`)
	d := New(Config{Runtime: config.Config{
		Version: config.Version, Executable: cli,
		MaxEventBytes: 1 << 20, MaxStderrBytes: 1 << 20, InterruptGraceMillis: 1000,
	}})
	sink := &recordingSink{}
	outcome, err := d.Run(context.Background(), runtime.Turn{Prompt: "go"}, sink)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if outcome.Failure != nil || outcome.Pending != nil {
		t.Fatalf("unexpected outcome: %+v", outcome)
	}
	if sink.session == "" {
		t.Fatal("expected SessionStarted with a continuation ID")
	}
	if got := sink.text.String(); got != "hello\nworld\n" {
		t.Fatalf("text deltas = %q, want %q", got, "hello\nworld\n")
	}
}

func TestRunReportsFailureOnNonzeroExit(t *testing.T) {
	cli := stubCLI(t, `cat >/dev/null; echo boom >&2; exit 3`)
	d := New(Config{Runtime: config.Config{
		Version: config.Version, Executable: cli,
		MaxEventBytes: 1 << 20, MaxStderrBytes: 1 << 20, InterruptGraceMillis: 1000,
	}})
	sink := &recordingSink{}
	outcome, err := d.Run(context.Background(), runtime.Turn{Prompt: "go"}, sink)
	if err != nil {
		t.Fatalf("Run returned err %v; want a Failure outcome", err)
	}
	if outcome.Failure == nil {
		t.Fatal("expected a Failure outcome for a non-zero exit")
	}
}

func TestRunRejectsEmptyPrompt(t *testing.T) {
	d := New(Config{Runtime: config.Config{Version: config.Version, Executable: "unused"}})
	if _, err := d.Run(context.Background(), runtime.Turn{}, &recordingSink{}); err == nil {
		t.Fatal("expected an error for an empty prompt")
	}
}
