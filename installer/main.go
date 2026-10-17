// Command installer installs the Loom Obsidian plugin into a vault.
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
)

const usage = `Install Loom into an Obsidian vault.

With no --vault the interactive installer starts, with a folder browser.

Usage: installer [flags]

Flags:
`

func main() {
	var (
		vault     = flag.String("vault", "", "vault folder; skips the interactive installer")
		src       = flag.String("src", "", "folder with the built plugin (default: auto-detect)")
		link      = flag.Bool("link", false, "symlink the plugin folder instead of copying (for development)")
		noEnable  = flag.Bool("no-enable", false, "do not add Loom to the vault's enabled plugins")
		force     = flag.Bool("force", false, "replace an existing real plugin folder when linking")
		uninstall = flag.Bool("uninstall", false, "remove Loom from --vault")
	)
	flag.Usage = func() {
		fmt.Fprint(os.Stderr, usage)
		flag.PrintDefaults()
	}
	flag.Parse()

	if *uninstall {
		if *vault == "" {
			fail("--uninstall needs --vault")
		}
		if err := Uninstall(expand(*vault)); err != nil {
			fail(err.Error())
		}
		fmt.Println("Loom removed from", expand(*vault))
		return
	}

	if *vault == "" {
		if err := run(Options{Src: *src, Link: *link}); err != nil {
			fail(err.Error())
		}
		return
	}

	source, err := FindSource(*src)
	if err != nil {
		fail(err.Error())
	}
	res, err := Install(Options{Vault: expand(*vault), Src: source, Link: *link, Enable: !*noEnable, Force: *force})
	if err != nil {
		fail(err.Error())
	}
	fmt.Printf("Loom %s into %s\n", res.Mode, res.Target)
	if res.Enabled {
		fmt.Println("Enabled in the vault. Restart Obsidian to load it.")
	} else {
		fmt.Println("Restart Obsidian, then turn on Loom under Settings → Community plugins.")
	}
}

func expand(p string) string {
	if strings.HasPrefix(p, "~") {
		if home, err := os.UserHomeDir(); err == nil {
			return home + p[1:]
		}
	}
	return p
}

func fail(msg string) {
	fmt.Fprintln(os.Stderr, "error:", msg)
	os.Exit(1)
}
