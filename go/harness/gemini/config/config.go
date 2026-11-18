// Package config defines the versioned, non-secret Gemini Harness runtime
// configuration shared by its compiler and Actor entrypoint.
// EXPERIMENTAL SCAFFOLD: GEMINI_API_KEY / GOOGLE_API_KEY; Vertex via GOOGLE_GENAI_USE_VERTEXAI + GOOGLE_CLOUD_PROJECT.
package config

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/niravshah2705/symphony/go/pkg/tracing"
)

const (
	Version = 1
	// PinnedGeminiVersion is the gemini release the Dockerfile installs by default.
	// It is NOT asserted at runtime (StrictVersion is false) because the experimental
	// scaffold has no validated upstream pin yet — set it once the feed is confirmed.
	PinnedGeminiVersion = "0.0.0"
	// DisableUpdatesEnvName keeps the native CLI from self-updating past the installed version.
	DisableUpdatesEnvName = "GEMINI_CLI_DISABLE_AUTO_UPGRADE"
)

// OwnsEnvironment reports whether the compiler or adapter reserves name for
// Gemini runtime configuration. Harness authors cannot override these values.
func OwnsEnvironment(name string) bool {
	switch name {
	case DisableUpdatesEnvName:
		return true
	default:
		return false
	}
}

type Config struct {
	MaxContentLength *int64   `json:"max_content_length,omitempty"`
	ControlPlaneURL  string   `json:"control_plane_url"`
	LogLevel         string   `json:"log_level,omitempty"`
	Version          int      `json:"version"`
	Executable       string   `json:"executable"`
	ExpectedVersion  string   `json:"expected_version"`
	StrictVersion    bool     `json:"strict_version"`
	Model            string   `json:"model,omitempty"`
	SystemPrompt     string   `json:"system_prompt,omitempty"`
	ExtraArgs        []string `json:"extra_args,omitempty"`
	// RuntimeTelemetry carries the compiler-owned span identity and content
	// capture policy. It is absent for standalone runs.
	RuntimeTelemetry     tracing.RuntimeTelemetry `json:"runtime_telemetry,omitzero"`
	MaxEventBytes        int                      `json:"max_event_bytes"`
	MaxStderrBytes       int                      `json:"max_stderr_bytes"`
	InterruptGraceMillis int                      `json:"interrupt_grace_millis"`
}

const maxEventBytes = 16 << 20

func Production(model, instruction string) Config {
	return Config{
		Version: Version, Executable: "gemini",
		StrictVersion: false, // no validated upstream pin yet — do not hard-fail a turn on version drift
		Model:         model, SystemPrompt: instruction,
		MaxEventBytes: maxEventBytes, MaxStderrBytes: 64 << 10,
		InterruptGraceMillis: 2000,
	}
}

func Parse(b []byte) (Config, error) {
	var cfg Config
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cfg); err != nil {
		return Config{}, fmt.Errorf("decode config: %w", err)
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		return Config{}, fmt.Errorf("decode config: trailing JSON value")
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) Validate() error {
	if c.MaxContentLength != nil && *c.MaxContentLength < 0 {
		return fmt.Errorf("max_content_length must be nonnegative")
	}
	switch c.LogLevel {
	case "", "debug", "info", "warn", "error":
	default:
		return fmt.Errorf("log_level must be debug, info, warn, or error")
	}
	if c.Version != Version {
		return fmt.Errorf("unsupported config version %d (want %d)", c.Version, Version)
	}
	if strings.TrimSpace(c.Executable) == "" {
		return fmt.Errorf("executable is required")
	}
	if c.StrictVersion && strings.TrimSpace(c.ExpectedVersion) == "" {
		return fmt.Errorf("expected_version is required when strict_version is enabled")
	}
	if c.MaxEventBytes <= 0 || c.MaxStderrBytes <= 0 || c.InterruptGraceMillis <= 0 {
		return fmt.Errorf("event, stderr, and interrupt grace limits must be positive")
	}
	return c.RuntimeTelemetry.Validate()
}

func (c Config) InterruptGrace() time.Duration {
	return time.Duration(c.InterruptGraceMillis) * time.Millisecond
}
