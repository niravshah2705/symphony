// Package adapter constructs the Qoder runtime from compiler-owned
// configuration and Actor-owned paths.
package adapter

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/niravshah2705/symphony/go/harness/internal/utils"
	"github.com/niravshah2705/symphony/go/harness/qoder/config"
	"github.com/niravshah2705/symphony/go/harness/qoder/internal/driver"
)

// Input contains compiler output and Actor-owned locations used to construct
// the Qoder driver.
type Input struct {
	ConfigJSON   []byte
	Workspace    string
	DurableDir   string
	EphemeralDir string
	Environment  []string
}

// New validates the configuration, materializes Qoder-owned state, and
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
		{name: "Qoder state", path: filepath.Join(input.DurableDir, "qoder")},
	} {
		if err := utils.EnsurePrivateDir(directory.path); err != nil {
			return nil, fmt.Errorf("prepare %s directory: %w", directory.name, err)
		}
	}
	// The image pins a qodercli version; keep the native runtime from
	// self-updating past the installed build.
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
