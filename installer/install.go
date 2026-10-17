package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const pluginID = "loom"

// main.js and manifest.json are required; styles.css is optional.
var requiredFiles = []string{"main.js", "manifest.json"}
var pluginFiles = []string{"main.js", "manifest.json", "styles.css"}

type Vault struct {
	Name string
	Path string
}

type Options struct {
	Vault  string
	Src    string // directory holding the built plugin files
	Link   bool   // symlink Src instead of copying files
	Enable bool   // add the plugin to community-plugins.json
	Force  bool   // replace a real directory when linking
}

type Result struct {
	Target  string
	Mode    string // "copied" or "linked"
	Enabled bool
}

// ValidVault reports whether path looks like an Obsidian vault.
func ValidVault(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return errors.New("that folder does not exist")
	}
	if !info.IsDir() {
		return errors.New("that is not a folder")
	}
	if st, err := os.Stat(filepath.Join(path, ".obsidian")); err != nil || !st.IsDir() {
		return errors.New("not an Obsidian vault: no .obsidian folder inside. Open it in Obsidian once first.")
	}
	return nil
}

// obsidianConfigs lists the places Obsidian keeps its vault registry.
func obsidianConfigs() []string {
	var out []string
	if dir, err := os.UserConfigDir(); err == nil {
		out = append(out, filepath.Join(dir, "obsidian", "obsidian.json"))
	}
	if home, err := os.UserHomeDir(); err == nil {
		out = append(out,
			filepath.Join(home, ".var", "app", "md.obsidian.Obsidian", "config", "obsidian", "obsidian.json"),
			filepath.Join(home, "snap", "obsidian", "current", ".config", "obsidian", "obsidian.json"),
		)
	}
	return out
}

// DetectVaults returns the vaults Obsidian knows about, most recently used first.
func DetectVaults() []Vault { return detectVaults(obsidianConfigs()) }

func detectVaults(configs []string) []Vault {
	type entry struct {
		v  Vault
		ts int64
	}
	var found []entry
	seen := map[string]bool{}
	for _, cfg := range configs {
		raw, err := os.ReadFile(cfg)
		if err != nil {
			continue
		}
		var data struct {
			Vaults map[string]struct {
				Path string `json:"path"`
				TS   int64  `json:"ts"`
			} `json:"vaults"`
		}
		if json.Unmarshal(raw, &data) != nil {
			continue
		}
		for _, v := range data.Vaults {
			if seen[v.Path] || ValidVault(v.Path) != nil {
				continue
			}
			seen[v.Path] = true
			found = append(found, entry{Vault{Name: filepath.Base(v.Path), Path: v.Path}, v.TS})
		}
	}
	sort.Slice(found, func(i, j int) bool { return found[i].ts > found[j].ts })
	out := make([]Vault, len(found))
	for i, f := range found {
		out[i] = f.v
	}
	return out
}

// FindSource locates the directory with the built plugin. An explicit dir wins;
// otherwise the working directory, the executable's directory and their parents are tried.
func FindSource(explicit string) (string, error) {
	var candidates []string
	if explicit != "" {
		candidates = []string{explicit}
	} else {
		if wd, err := os.Getwd(); err == nil {
			candidates = append(candidates, wd, filepath.Dir(wd))
		}
		if exe, err := os.Executable(); err == nil {
			d := filepath.Dir(exe)
			candidates = append(candidates, d, filepath.Dir(d))
		}
	}
	for _, c := range candidates {
		if abs, err := filepath.Abs(c); err == nil && isPluginDir(abs) {
			return abs, nil
		}
	}
	if explicit != "" {
		return "", fmt.Errorf("%s does not contain a built Loom plugin (main.js and manifest.json)", explicit)
	}
	return "", errors.New("could not find the built plugin (main.js). Run `npm run build` in the Loom folder first, or pass --src")
}

func isPluginDir(dir string) bool {
	for _, f := range requiredFiles {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			return false
		}
	}
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return false
	}
	var m struct {
		ID string `json:"id"`
	}
	return json.Unmarshal(raw, &m) == nil && m.ID == pluginID
}

func pluginDir(vault string) string {
	return filepath.Join(vault, ".obsidian", "plugins", pluginID)
}

// Install copies (or links) the plugin into the vault. data.json, which holds the
// user's settings and API key, is never touched.
func Install(o Options) (Result, error) {
	if err := ValidVault(o.Vault); err != nil {
		return Result{}, err
	}
	if !isPluginDir(o.Src) {
		return Result{}, fmt.Errorf("%s does not contain a built Loom plugin", o.Src)
	}
	target := pluginDir(o.Vault)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return Result{}, err
	}

	res := Result{Target: target}
	info, statErr := os.Lstat(target)
	isLink := statErr == nil && info.Mode()&os.ModeSymlink != 0

	if o.Link {
		res.Mode = "linked"
		switch {
		case isLink:
			if err := os.Remove(target); err != nil {
				return res, err
			}
		case statErr == nil:
			if !o.Force {
				return res, fmt.Errorf("%s already exists as a real folder; linking would replace it and its settings (use --force)", target)
			}
			if err := os.RemoveAll(target); err != nil {
				return res, err
			}
		}
		if err := os.Symlink(o.Src, target); err != nil {
			return res, err
		}
	} else {
		res.Mode = "copied"
		// Never copy through a symlink: that would overwrite the files in the source repo.
		if isLink {
			if err := os.Remove(target); err != nil {
				return res, err
			}
		}
		if err := os.MkdirAll(target, 0o755); err != nil {
			return res, err
		}
		for _, f := range pluginFiles {
			src := filepath.Join(o.Src, f)
			if _, err := os.Stat(src); err != nil {
				continue
			}
			if err := copyFile(src, filepath.Join(target, f)); err != nil {
				return res, err
			}
		}
	}

	if o.Enable {
		changed, err := setEnabled(o.Vault, true)
		if err != nil {
			return res, err
		}
		res.Enabled = changed || isEnabled(o.Vault)
	}
	return res, nil
}

// Uninstall removes the plugin folder (or link) and its community-plugins.json entry.
func Uninstall(vault string) error {
	if err := ValidVault(vault); err != nil {
		return err
	}
	if err := os.RemoveAll(pluginDir(vault)); err != nil {
		return err
	}
	_, err := setEnabled(vault, false)
	return err
}

func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

func communityFile(vault string) string {
	return filepath.Join(vault, ".obsidian", "community-plugins.json")
}

func readEnabled(vault string) ([]string, error) {
	raw, err := os.ReadFile(communityFile(vault))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var ids []string
	if err := json.Unmarshal(raw, &ids); err != nil {
		return nil, fmt.Errorf("community-plugins.json is not a JSON list: %w", err)
	}
	return ids, nil
}

func isEnabled(vault string) bool {
	ids, _ := readEnabled(vault)
	for _, id := range ids {
		if id == pluginID {
			return true
		}
	}
	return false
}

// setEnabled adds or removes the plugin id, keeping every other entry. It reports whether the file changed.
func setEnabled(vault string, on bool) (bool, error) {
	ids, err := readEnabled(vault)
	if err != nil {
		return false, err
	}
	var out []string
	has := false
	for _, id := range ids {
		if id == pluginID {
			has = true
			if !on {
				continue
			}
		}
		out = append(out, id)
	}
	if (on && has) || (!on && !has) {
		return false, nil
	}
	if on {
		out = append(out, pluginID)
	}
	if out == nil {
		out = []string{}
	}
	raw, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return false, err
	}
	return true, os.WriteFile(communityFile(vault), append(raw, '\n'), 0o644)
}

// tilde shortens a path under $HOME for display.
func tilde(p string) string {
	if home, err := os.UserHomeDir(); err == nil && strings.HasPrefix(p, home) {
		return "~" + strings.TrimPrefix(p, home)
	}
	return p
}
