package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func fixture(t *testing.T) (src, vault string) {
	t.Helper()
	src = t.TempDir()
	write(t, filepath.Join(src, "main.js"), "// built")
	write(t, filepath.Join(src, "manifest.json"), `{"id":"loom","name":"Loom"}`)
	write(t, filepath.Join(src, "styles.css"), "/* css */")
	vault = t.TempDir()
	if err := os.MkdirAll(filepath.Join(vault, ".obsidian"), 0o755); err != nil {
		t.Fatal(err)
	}
	return src, vault
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestValidVault(t *testing.T) {
	_, vault := fixture(t)
	if err := ValidVault(vault); err != nil {
		t.Fatal(err)
	}
	if err := ValidVault(t.TempDir()); err == nil || !strings.Contains(err.Error(), "not an Obsidian vault") {
		t.Fatalf("plain folder accepted: %v", err)
	}
	if err := ValidVault(filepath.Join(vault, "missing")); err == nil {
		t.Fatal("missing folder accepted")
	}
}

func TestDetectVaults(t *testing.T) {
	_, a := fixture(t)
	_, b := fixture(t)
	cfg := filepath.Join(t.TempDir(), "obsidian.json")
	data, _ := json.Marshal(map[string]any{"vaults": map[string]any{
		"1": map[string]any{"path": a, "ts": 100},
		"2": map[string]any{"path": b, "ts": 200},
		"3": map[string]any{"path": "/does/not/exist", "ts": 300},
	}})
	write(t, cfg, string(data))
	got := detectVaults([]string{cfg, filepath.Join(t.TempDir(), "none.json")})
	if len(got) != 2 || got[0].Path != b || got[1].Path != a {
		t.Fatalf("want [b a] newest first, dropping missing vault: %+v", got)
	}
}

func TestFindSource(t *testing.T) {
	src, _ := fixture(t)
	if got, err := FindSource(src); err != nil || got != src {
		t.Fatalf("explicit: %v %v", got, err)
	}
	if _, err := FindSource(t.TempDir()); err == nil {
		t.Fatal("empty dir accepted")
	}
	write(t, filepath.Join(src, "manifest.json"), `{"id":"other"}`)
	if _, err := FindSource(src); err == nil {
		t.Fatal("wrong plugin id accepted")
	}
}

func TestInstallCopyKeepsData(t *testing.T) {
	src, vault := fixture(t)
	opts := Options{Vault: vault, Src: src, Enable: true}
	res, err := Install(opts)
	if err != nil || res.Mode != "copied" || !res.Enabled {
		t.Fatalf("%+v %v", res, err)
	}
	dst := pluginDir(vault)
	if read(t, filepath.Join(dst, "main.js")) != "// built" {
		t.Fatal("main.js not copied")
	}
	write(t, filepath.Join(dst, "data.json"), `{"apiKey":"secret"}`)
	write(t, filepath.Join(src, "main.js"), "// v2")
	if _, err := Install(opts); err != nil {
		t.Fatal(err)
	}
	if read(t, filepath.Join(dst, "main.js")) != "// v2" {
		t.Fatal("upgrade did not replace main.js")
	}
	if read(t, filepath.Join(dst, "data.json")) != `{"apiKey":"secret"}` {
		t.Fatal("data.json was touched")
	}
}

func TestInstallLink(t *testing.T) {
	src, vault := fixture(t)
	res, err := Install(Options{Vault: vault, Src: src, Link: true})
	if err != nil || res.Mode != "linked" {
		t.Fatalf("%+v %v", res, err)
	}
	if got, _ := os.Readlink(pluginDir(vault)); got != src {
		t.Fatalf("link points to %q", got)
	}
	// Re-linking is fine; so is switching to copy mode, which must not write through the link.
	if _, err := Install(Options{Vault: vault, Src: src, Link: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(Options{Vault: vault, Src: src}); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Lstat(pluginDir(vault)); info.Mode()&os.ModeSymlink != 0 {
		t.Fatal("still a symlink after copy install")
	}
	if read(t, filepath.Join(src, "main.js")) != "// built" {
		t.Fatal("source file was modified")
	}
}

func TestLinkRefusesRealFolderWithoutForce(t *testing.T) {
	src, vault := fixture(t)
	write(t, filepath.Join(pluginDir(vault), "data.json"), "{}")
	if _, err := Install(Options{Vault: vault, Src: src, Link: true}); err == nil {
		t.Fatal("replaced a real folder without --force")
	}
	if _, err := Install(Options{Vault: vault, Src: src, Link: true, Force: true}); err != nil {
		t.Fatal(err)
	}
}

func TestEnableIsIdempotentAndPreservesOthers(t *testing.T) {
	src, vault := fixture(t)
	write(t, communityFile(vault), `["remotely-save"]`)
	for i := 0; i < 2; i++ {
		if _, err := Install(Options{Vault: vault, Src: src, Enable: true}); err != nil {
			t.Fatal(err)
		}
	}
	ids, _ := readEnabled(vault)
	if !reflect.DeepEqual(ids, []string{"remotely-save", "loom"}) {
		t.Fatalf("got %v", ids)
	}
}

func TestInstallWithoutEnableLeavesListAlone(t *testing.T) {
	src, vault := fixture(t)
	if _, err := Install(Options{Vault: vault, Src: src}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(communityFile(vault)); err == nil {
		t.Fatal("community-plugins.json created without Enable")
	}
}

func TestBadCommunityFileIsReportedNotOverwritten(t *testing.T) {
	src, vault := fixture(t)
	write(t, communityFile(vault), `{"oops":true}`)
	if _, err := Install(Options{Vault: vault, Src: src, Enable: true}); err == nil {
		t.Fatal("expected error")
	}
	if read(t, communityFile(vault)) != `{"oops":true}` {
		t.Fatal("file was overwritten")
	}
}

func TestUninstall(t *testing.T) {
	src, vault := fixture(t)
	write(t, communityFile(vault), `["remotely-save"]`)
	if _, err := Install(Options{Vault: vault, Src: src, Enable: true}); err != nil {
		t.Fatal(err)
	}
	if err := Uninstall(vault); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(pluginDir(vault)); err == nil {
		t.Fatal("plugin folder still there")
	}
	if ids, _ := readEnabled(vault); !reflect.DeepEqual(ids, []string{"remotely-save"}) {
		t.Fatalf("got %v", ids)
	}
	// Uninstalling a link leaves the source alone.
	if _, err := Install(Options{Vault: vault, Src: src, Link: true}); err != nil {
		t.Fatal(err)
	}
	if err := Uninstall(vault); err != nil {
		t.Fatal(err)
	}
	if read(t, filepath.Join(src, "main.js")) != "// built" {
		t.Fatal("source removed")
	}
}
