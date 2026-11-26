package config

import (
	"strings"
	"testing"
)

const strictDocument = `{
	"version": 1,
	"executable": "qodercli",
	"expected_version": "1.1.92",
	"strict_version": true,
	"control_plane_url": "https://cp.example",
	"model": "mock-gpt",
	"system_prompt": "be concise",
	"max_event_bytes": 16777216,
	"max_stderr_bytes": 65536,
	"interrupt_grace_millis": 2000
}`

const adkDocument = `{
	"runtime": {"name": "test-agent-qoder-worker", "namespace": "org-test",
	            "control_plane_url": "http://kagent-control-plane.kagent.svc", "log_level": "debug"},
	"agent": {"name": "test-agent-qoder-worker",
	          "instruction": "You are a concise coding agent. Plan, then act.\n",
	          "model": {"model": "openrouter/qwen/qwen3.8-flash",
	                    "headers": {"x-fleet-org-id": "org-1"}}},
	"token_propagation": {"unmodeled": true}
}`

func TestParseAcceptsStrictDocument(t *testing.T) {
	cfg, err := Parse([]byte(strictDocument))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.Executable != "qodercli" || !cfg.StrictVersion || cfg.Model != "mock-gpt" {
		t.Fatalf("unexpected config: %+v", cfg)
	}
}

func TestParseRejectsUnknownField(t *testing.T) {
	if _, err := Parse([]byte(`{"version":1,"executable":"qodercli","nope":true}`)); err == nil {
		t.Fatal("expected strict Parse to reject an unknown field")
	}
}

func TestIsADKDocument(t *testing.T) {
	if IsADKDocument([]byte(strictDocument)) {
		t.Fatal("a strict document must not be classified as ADK")
	}
	if !IsADKDocument([]byte(adkDocument)) {
		t.Fatal("an ADK document was not classified as ADK")
	}
	if IsADKDocument([]byte(`[]`)) || IsADKDocument([]byte(`not json`)) {
		t.Fatal("a non-object or invalid document must not be classified as ADK")
	}
}

func TestFromADKMapsBundleFields(t *testing.T) {
	cfg, err := FromADK([]byte(adkDocument))
	if err != nil {
		t.Fatalf("FromADK: %v", err)
	}
	if cfg.Executable != "qodercli" {
		t.Errorf("executable = %q, want the image's CLI", cfg.Executable)
	}
	if cfg.Version != Version {
		t.Errorf("version = %d, want %d", cfg.Version, Version)
	}
	if cfg.Model != "openrouter/qwen/qwen3.8-flash" {
		t.Errorf("model = %q", cfg.Model)
	}
	if !strings.HasPrefix(cfg.SystemPrompt, "You are a concise coding agent") {
		t.Errorf("system_prompt = %q", cfg.SystemPrompt)
	}
	if cfg.ControlPlaneURL != "http://kagent-control-plane.kagent.svc" {
		t.Errorf("control_plane_url = %q", cfg.ControlPlaneURL)
	}
	if cfg.LogLevel != "debug" {
		t.Errorf("log_level = %q", cfg.LogLevel)
	}
	if cfg.StrictVersion || cfg.ExpectedVersion != "" {
		t.Errorf("a BYO bundle must not assert the image pin: strict=%v expected=%q", cfg.StrictVersion, cfg.ExpectedVersion)
	}
	if cfg.MaxEventBytes <= 0 || cfg.MaxStderrBytes <= 0 || cfg.InterruptGraceMillis <= 0 {
		t.Errorf("production limits missing: %+v", cfg)
	}
	if cfg.RuntimeTelemetry.Runtime != "" || cfg.RuntimeTelemetry.AgentName != "" {
		t.Errorf("runtime telemetry must stay empty for an ADK bundle: %+v", cfg.RuntimeTelemetry)
	}
}

func TestFromADKRejectsForeignDocument(t *testing.T) {
	if _, err := FromADK([]byte(strictDocument)); err == nil {
		t.Fatal("expected an ADK read of a strict document to fail")
	}
	if _, err := FromADK([]byte(`{"runtime":{"log_level":"verbose"}}`)); err == nil {
		t.Fatal("expected an invalid log_level to fail validation")
	}
}

func TestLoadPrefersStrictAndFallsBackToADK(t *testing.T) {
	cfg, source, err := Load([]byte(strictDocument))
	if err != nil {
		t.Fatalf("Load(strict): %v", err)
	}
	if source != "qoder" || cfg.Model != "mock-gpt" {
		t.Fatalf("Load(strict) = source %q config %+v", source, cfg)
	}
	if _, adkSource, err := Load([]byte(adkDocument)); err != nil {
		t.Fatalf("Load(ADK): %v", err)
	} else if adkSource != "adk" {
		t.Fatalf("Load(ADK) source = %q, want adk", adkSource)
	}
	if _, _, err := Load([]byte(`{"version":2,"executable":"qodercli"}`)); err == nil {
		t.Fatal("expected an unsupported version to fail with no ADK fallback")
	}
	if _, _, err := Load([]byte(`garbage`)); err == nil {
		t.Fatal("expected invalid JSON to fail with no ADK fallback")
	}
}
