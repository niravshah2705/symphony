// Package config defines the versioned, non-secret Qoder Harness runtime
// configuration shared by its compiler and Actor entrypoint.
// EXPERIMENTAL SCAFFOLD: QODER_PERSONAL_ACCESS_TOKEN; CANNOT run under egress proxy (fail closed).
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
	// PinnedQoderVersion is the qodercli release the Dockerfile installs by default.
	// It is asserted at runtime: the image installs exactly this version and Validate
	// fails a turn if `--version` does not report it.
	PinnedQoderVersion = "1.1.92"
	// DisableUpdatesEnvName keeps the native CLI from self-updating past the installed version.
	DisableUpdatesEnvName = "QODER_DISABLE_AUTO_UPDATE"
)

// OwnsEnvironment reports whether the compiler or adapter reserves name for
// Qoder runtime configuration. Harness authors cannot override these values.
func OwnsEnvironment(name string) bool {
	switch name {
	case DisableUpdatesEnvName:
		return true
	default:
		return false
	}
}

// QoderApiKeyEnvName is the env key the qodercli BYOK subsystem reads the model
// credential from (declared by a custom provider entry, behind
// QODER_SDK_CUSTOM_BASE_URL_BYOK=1). It is a fleet-authored name, not a CLI
// built-in, and the fleet supplies it from the tenant's LiteLLM virtual key —
// never as a literal in a Harness CR.
const QoderApiKeyEnvName = "QODER_API_KEY"

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
		Version: Version, Executable: "qodercli",
		ExpectedVersion: PinnedQoderVersion, StrictVersion: true,
		Model: model, SystemPrompt: instruction,
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

// adkBundle mirrors the subset of the kagent ADK configuration document
// (kagent/config/v1 ADKConfig) that a BYO Harness hands to an unmanaged
// runtime. It is deliberately a local struct rather than the generated type:
// this package keeps its dependency set, and the ProtoJSON names below are the
// wire contract, not the Go API.
type adkBundle struct {
	Runtime *struct {
		Name            string `json:"name"`
		Namespace       string `json:"namespace"`
		ControlPlaneURL string `json:"control_plane_url"`
		LogLevel        string `json:"log_level"`
	} `json:"runtime"`
	Agent *struct {
		Name        string `json:"name"`
		Instruction string `json:"instruction"`
		Model       *struct {
			Model string `json:"model"`
		} `json:"model"`
	} `json:"agent"`
}

// IsADKDocument reports whether b is an ADK-shaped config rather than this
// package's strict one. A BYO bundle always carries a runtime and/or agent
// object; neither name exists in the strict Config.
func IsADKDocument(b []byte) bool {
	var probe adkBundle
	if err := json.Unmarshal(b, &probe); err != nil {
		return false
	}
	return probe.Runtime != nil || probe.Agent != nil
}

// FromADK compiles a BYO ADK configuration document into a runtime Config.
// The bundle carries no executable or version pin — those belong to the image,
// which installs exactly PinnedQoderVersion — so the strict pin is not asserted
// here and driver.Validate still checks the CLI reports an installed version.
func FromADK(b []byte) (Config, error) {
	var doc adkBundle
	if err := json.Unmarshal(b, &doc); err != nil {
		return Config{}, fmt.Errorf("decode ADK config: %w", err)
	}
	if doc.Runtime == nil && doc.Agent == nil {
		return Config{}, fmt.Errorf("ADK config has neither a runtime nor an agent object")
	}
	cfg := Production("", "")
	cfg.StrictVersion = false
	cfg.ExpectedVersion = ""
	if doc.Runtime != nil {
		cfg.ControlPlaneURL = doc.Runtime.ControlPlaneURL
		cfg.LogLevel = doc.Runtime.LogLevel
	}
	if doc.Agent != nil {
		cfg.SystemPrompt = doc.Agent.Instruction
		if doc.Agent.Model != nil {
			cfg.Model = doc.Agent.Model.Model
		}
	}
	// RuntimeTelemetry stays zero: a span may only name a runtime the weaver
	// registry knows, and it has no qoder entry. A partial identity would also
	// fail Config.Validate, which requires runtime, agent name and namespace
	// together.
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// Load parses the bootstrap configuration document from either author,
// returning which shape was read so the entrypoint can log the path it took.
// A strict document is never silently reinterpreted: the ADK fallback only
// applies to a bundle that is unambiguously ADK-shaped.
func Load(b []byte) (Config, string, error) {
	cfg, err := Parse(b)
	if err == nil {
		return cfg, "qoder", nil
	}
	if !IsADKDocument(b) {
		return Config{}, "", err
	}
	adk, adkErr := FromADK(b)
	if adkErr != nil {
		return Config{}, "", fmt.Errorf("%w (ADK fallback also failed: %v)", err, adkErr)
	}
	return adk, "adk", nil
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
