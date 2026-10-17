package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/charmbracelet/bubbles/filepicker"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type step int

const (
	stepVault step = iota
	stepType
	stepBrowse
	stepOptions
	stepDone
)

var (
	accent  = lipgloss.Color("75")
	green   = lipgloss.Color("78")
	red     = lipgloss.Color("203")
	muted   = lipgloss.Color("244")
	title   = lipgloss.NewStyle().Bold(true).Foreground(accent)
	dim     = lipgloss.NewStyle().Foreground(muted)
	okStyle = lipgloss.NewStyle().Foreground(green)
	errText = lipgloss.NewStyle().Foreground(red)
	sel     = lipgloss.NewStyle().Foreground(accent).Bold(true)
	frame   = lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(accent).Padding(1, 2)
)

type model struct {
	step   step
	vaults []Vault
	cursor int
	opts   Options
	err    string // inline validation message

	input  textinput.Model
	picker filepicker.Model

	optCursor int
	existing  bool

	result *Result
	failed error

	width, height int
}

func newModel(opts Options) model {
	in := textinput.New()
	in.Placeholder = "/path/to/your/vault"
	in.Prompt = "› "
	in.CharLimit = 512
	in.Width = 60

	fp := filepicker.New()
	fp.DirAllowed = true
	fp.FileAllowed = false
	fp.ShowHidden = false
	fp.CurrentDirectory, _ = os.UserHomeDir()
	fp.AutoHeight = false
	fp.Height = 14

	opts.Enable = true
	return model{vaults: DetectVaults(), opts: opts, input: in, picker: fp}
}

func (m model) Init() tea.Cmd { return m.picker.Init() }

// list rows: detected vaults, then the two manual options.
func (m model) rows() []string {
	rows := make([]string, 0, len(m.vaults)+2)
	for _, v := range m.vaults {
		rows = append(rows, v.Name+"  "+dim.Render(tilde(v.Path)))
	}
	return append(rows, "Type a path…", "Browse folders…")
}

type installDone struct {
	res Result
	err error
}

func (m model) install() tea.Cmd {
	opts := m.opts
	return func() tea.Msg {
		res, err := Install(opts)
		return installDone{res, err}
	}
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.picker.Height = max(3, min(16, msg.Height-17))
		return m, nil
	case installDone:
		m.step = stepDone
		if msg.err != nil {
			m.failed = msg.err
		} else {
			m.result = &msg.res
		}
		return m, nil
	case tea.KeyMsg:
		if msg.String() == "ctrl+c" {
			return m, tea.Quit
		}
	}

	switch m.step {
	case stepVault:
		return m.updateVault(msg)
	case stepType:
		return m.updateType(msg)
	case stepBrowse:
		return m.updateBrowse(msg)
	case stepOptions:
		return m.updateOptions(msg)
	default:
		if k, ok := msg.(tea.KeyMsg); ok {
			switch k.String() {
			case "b":
				if m.failed != nil {
					m.failed, m.step, m.err = nil, stepOptions, ""
				}
			case "q", "enter", "esc":
				return m, tea.Quit
			}
		}
	}
	return m, nil
}

// chooseVault validates path and moves to the options step, or shows why not.
func (m model) chooseVault(path string) model {
	if err := ValidVault(path); err != nil {
		m.err = err.Error()
		return m
	}
	m.err = ""
	m.opts.Vault = path
	_, err := os.Lstat(pluginDir(path))
	m.existing = err == nil
	m.optCursor = 0
	m.step = stepOptions
	return m
}

func (m model) updateVault(msg tea.Msg) (tea.Model, tea.Cmd) {
	k, ok := msg.(tea.KeyMsg)
	if !ok {
		return m, nil
	}
	n := len(m.rows())
	switch k.String() {
	case "q", "esc":
		return m, tea.Quit
	case "up", "k":
		m.cursor = (m.cursor + n - 1) % n
	case "down", "j":
		m.cursor = (m.cursor + 1) % n
	case "enter":
		switch {
		case m.cursor < len(m.vaults):
			return m.chooseVault(m.vaults[m.cursor].Path), nil
		case m.cursor == len(m.vaults):
			m.err, m.step = "", stepType
			m.input.SetValue("")
			return m, m.input.Focus()
		default:
			m.err, m.step = "", stepBrowse
			return m, m.picker.Init()
		}
	}
	return m, nil
}

func (m model) updateType(msg tea.Msg) (tea.Model, tea.Cmd) {
	if k, ok := msg.(tea.KeyMsg); ok {
		switch k.String() {
		case "esc":
			m.err, m.step = "", stepVault
			return m, nil
		case "enter":
			p := strings.TrimSpace(m.input.Value())
			if strings.HasPrefix(p, "~") {
				if home, err := os.UserHomeDir(); err == nil {
					p = home + p[1:]
				}
			}
			return m.chooseVault(p), nil
		}
	}
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	return m, cmd
}

func (m model) updateBrowse(msg tea.Msg) (tea.Model, tea.Cmd) {
	if k, ok := msg.(tea.KeyMsg); ok {
		switch k.String() {
		case "q":
			m.err, m.step = "", stepVault
			return m, nil
		case ".":
			// Use the folder being viewed rather than one inside it.
			return m.chooseVault(m.picker.CurrentDirectory), nil
		}
	}
	prev := m.picker
	var cmd tea.Cmd
	m.picker, cmd = m.picker.Update(msg)
	if ok, path := m.picker.DidSelectFile(msg); ok {
		chosen := m.chooseVault(path)
		if chosen.err != "" {
			// Stay in the folder the user was browsing instead of following the rejected pick.
			chosen.picker = prev
			return chosen, nil
		}
		return chosen, cmd
	}
	return m, cmd
}

func (m model) updateOptions(msg tea.Msg) (tea.Model, tea.Cmd) {
	k, ok := msg.(tea.KeyMsg)
	if !ok {
		return m, nil
	}
	switch k.String() {
	case "esc":
		m.step = stepVault
	case "up", "k":
		m.optCursor = (m.optCursor + 2) % 3
	case "down", "j", "tab":
		m.optCursor = (m.optCursor + 1) % 3
	case " ", "enter", "left", "right", "h", "l":
		switch m.optCursor {
		case 0:
			m.opts.Link = !m.opts.Link
		case 1:
			m.opts.Enable = !m.opts.Enable
		case 2:
			if k.String() == "enter" || k.String() == " " {
				src, err := FindSource(m.opts.Src)
				if err != nil {
					m.step, m.failed = stepDone, err
					return m, nil
				}
				m.opts.Src = src
				// The TUI already showed the user the existing install; linking over a real folder is their call.
				m.opts.Force = m.existing
				return m, m.install()
			}
		}
	}
	return m, nil
}

func (m model) View() string {
	var b strings.Builder
	b.WriteString(title.Render("Loom installer") + "\n\n")

	switch m.step {
	case stepVault:
		b.WriteString("Where is your Obsidian vault?\n\n")
		for i, r := range m.rows() {
			if i == len(m.vaults) && len(m.vaults) > 0 {
				b.WriteString("\n")
			}
			b.WriteString(cursorLine(i == m.cursor, r))
		}
		if len(m.vaults) == 0 {
			b.WriteString("\n" + dim.Render("No vaults found in Obsidian's settings; type or browse to one.") + "\n")
		}
		b.WriteString(m.errLine() + "\n" + dim.Render("↑/↓ move · enter choose · q quit"))
	case stepType:
		b.WriteString("Vault folder:\n\n" + m.input.View() + "\n")
		b.WriteString(m.errLine() + "\n" + dim.Render("enter confirm · esc back"))
	case stepBrowse:
		b.WriteString("Browse to your vault folder\n")
		b.WriteString(dim.Render(tilde(m.picker.CurrentDirectory)) + "\n\n")
		b.WriteString(m.picker.View() + "\n")
		b.WriteString(m.errLine() + "\n" + dim.Render("↑/↓ move · →/l open · ←/h up · enter choose · . use this folder · q back"))
	case stepOptions:
		b.WriteString("Vault: " + sel.Render(tilde(m.opts.Vault)) + "\n")
		if m.existing {
			b.WriteString(dim.Render("Loom is already installed here; this will update it. Your settings are kept.") + "\n")
		}
		b.WriteString("\n")
		method := "Copy files"
		if m.opts.Link {
			method = "Link to this folder (for development)"
		}
		b.WriteString(cursorLine(m.optCursor == 0, "Method: "+method))
		b.WriteString(cursorLine(m.optCursor == 1, "Enable Loom in this vault: "+yesNo(m.opts.Enable)))
		b.WriteString("\n" + cursorLine(m.optCursor == 2, okStyle.Render("Install")))
		b.WriteString("\n" + dim.Render("↑/↓ move · space/enter change · esc back"))
	case stepDone:
		b.WriteString(m.doneView())
	}
	return frame.Render(b.String()) + "\n"
}

func (m model) doneView() string {
	if m.failed != nil {
		return errText.Render("✗ Install failed") + "\n\n" + m.failed.Error() + "\n\n" + dim.Render("b back · q quit")
	}
	r := m.result
	var b strings.Builder
	b.WriteString(okStyle.Render("✓ Loom "+r.Mode) + "\n" + dim.Render(tilde(r.Target)) + "\n\n")
	b.WriteString("Next:\n")
	b.WriteString("  1. Restart Obsidian, or run “Reload app without saving”.\n")
	if r.Enabled {
		b.WriteString("  2. If it asks, trust the vault's plugins (Settings → Community plugins).\n")
	} else {
		b.WriteString("  2. Settings → Community plugins → turn on Loom.\n")
	}
	b.WriteString("  3. Run “Loom: Connect to a model…” from the command palette.\n\n")
	b.WriteString(dim.Render("q quit"))
	return b.String()
}

func (m model) errLine() string {
	if m.err == "" {
		return ""
	}
	return "\n" + errText.Width(70).Render("✗ "+m.err) + "\n"
}

func cursorLine(active bool, s string) string {
	if active {
		return sel.Render("▸ ") + s + "\n"
	}
	return "  " + s + "\n"
}

func yesNo(b bool) string {
	if b {
		return okStyle.Render("yes")
	}
	return "no"
}

func run(opts Options) error {
	m := newModel(opts)
	final, err := tea.NewProgram(m, tea.WithAltScreen()).Run()
	if err != nil {
		return err
	}
	// Leave a plain summary in the scrollback since the alt screen vanishes on exit.
	if fm, ok := final.(model); ok && fm.result != nil {
		fmt.Printf("Loom %s into %s\n", fm.result.Mode, tilde(fm.result.Target))
	}
	return nil
}
