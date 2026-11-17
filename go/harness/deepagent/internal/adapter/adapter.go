// Package adapter constructs the DeepAgent runtime from compiler-owned
// configuration and Actor-owned paths.
package adapter

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/niravshah2705/symphony/go/harness/deepagent/config"
	"github.com/niravshah2705/symphony/go/harness/deepagent/internal/driver"
	"github.com/niravshah2705/symphony/go/harness/internal/utils"
)

// Input contains compiler output and Actor-owned locations used to construct
// the DeepAgent driver.
type Input struct {
	ConfigJSON   []byte
	Workspace    string
	DurableDir   string
	EphemeralDir string
	Environment  []string
}

// New validates the configuration, materializes DeepAgent-owned state, and
// constructs its driver.
func New(_ context.Context, input Input) (*driver.Driver, error) {
	cfg, err := config.Parse(input.ConfigJSON)
	if err != nil {
		return nil, err
	}
	if !filepath.IsAbs(input.Workspace) || !filepath.IsAbs(input.DurableDir) || !filepath.IsAbs(input.EphemeralDir) {
		return nil, fmt.Errorf("workspace, durable, and ephemeral directories must be absolute paths")
	}
	for _, directory := range []struct{ name, path string }{
		{name: "workspace", path: input.Workspace},
		{name: "DeepAgent state", path: filepath.Join(input.DurableDir, "deepagent")},
	} {
		if err := utils.EnsurePrivateDir(directory.path); err != nil {
			return nil, fmt.Errorf("prepare %s directory: %w", directory.name, err)
		}
	}
	// The image and compiler pin an exact deepagents-code version. Prevent the
	// native runtime from self-updating past the version validated at startup.
	environment := append([]string{}, input.Environment...)
	environment = setEnv(environment, config.DisableUpdatesEnvName, "1")
	return driver.New(driver.Config{
		Runtime:     cfg,
		Workspace:   input.Workspace,
		Environment: environment,
	}), nil
}

// setEnv replaces or appends one KEY=VALUE entry in a copy of the environment.
func setEnv(environment []string, key, value string) []string {
	out := make([]string, 0, len(environment)+1)
	for _, entry := range environment {
		if len(entry) >= len(key) && entry[:len(key)] == key+"=" {
			continue
		}
		out = append(out, entry)
	}
	return append(out, key+"="+value)
}
