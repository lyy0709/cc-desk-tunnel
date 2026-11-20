package main

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"
)

func TestProjectBoundary(t *testing.T) {
	parent := t.TempDir()
	base := filepath.Join(parent, "project")
	if err := os.Mkdir(base, 0700); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(base)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	id, err := run(root, input{Op: "bind"})
	if err != nil {
		t.Fatal(err)
	}
	call := func(q input) (result, error) { q.Identity = id.Text; return run(root, q) }
	if _, err = call(input{Op: "create", Path: "index.txt", New: "a\r\nb\r\n"}); err != nil {
		t.Fatal(err)
	}
	r, err := call(input{Op: "read", Path: "index.txt"})
	if err != nil || r.Text != "a\r\nb\r\n" {
		t.Fatalf("read %v %v", r, err)
	}
	if _, err = call(input{Op: "edit", Path: "index.txt", Revision: r.Revision, Old: "b", New: "B"}); err != nil {
		t.Fatal(err)
	}
	if _, err = call(input{Op: "edit", Path: "index.txt", Revision: r.Revision, Old: "a", New: "x"}); err == nil {
		t.Fatal("stale edit accepted")
	}
	for _, p := range []string{"../outside", "C:/private", "/etc", "\\\\server\\share", "a:b"} {
		if _, err = call(input{Op: "create", Path: p, New: "x"}); err == nil {
			t.Fatalf("outside path accepted: %s", p)
		}
	}
	if _, err = run(root, input{Op: "read", Path: "index.txt", Identity: "replaced"}); err == nil {
		t.Fatal("root identity ignored")
	}
	if err = os.Symlink(parent, filepath.Join(base, "external")); err == nil {
		if _, err = call(input{Op: "create", Path: "external/out", New: "x"}); err == nil {
			t.Fatal("escaped linked directory")
		}
	}
	if _, err := os.Stat(filepath.Join(parent, "out")); !os.IsNotExist(err) {
		t.Fatal("wrote outside project")
	}
	if _, err := call(input{Op: "create", Path: "large", New: strings.Repeat("页", 20000)}); err != nil {
		t.Fatal(err)
	}
	first, e := call(input{Op: "read", Path: "large"})
	second, e2 := call(input{Op: "read", Path: "large", Offset: first.Next})
	if e != nil || e2 != nil || len(first.Text) != first.Next || first.Next == 0 || !strings.HasPrefix(second.Text, "页") {
		t.Fatalf("invalid pages %v %v", e, e2)
	}
}

func TestSearchLeavesOutDependenciesAndSurvivesUnreadableEntries(t *testing.T) {
	base := t.TempDir()
	write := func(name, text string) {
		t.Helper()
		full := filepath.Join(base, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(full), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("src/a.txt", "first\nneedle here\n")
	write("node_modules/pkg/index.js", "needle in a dependency\n")
	write("web/dist/out.js", "needle in build output\n")
	write(".git/config", "needle in version control\n")
	write("locked/inner.txt", "needle behind a closed door\n")
	write("src/closed.txt", "needle in an unreadable file\n")
	root, err := os.OpenRoot(base)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	id, err := run(root, input{Op: "bind"})
	if err != nil {
		t.Fatal(err)
	}
	call := func(q input) (result, error) { q.Identity = id.Text; return run(root, q) }
	everywhere, err := call(input{Op: "search", Path: ".", Query: "needle"})
	if err != nil {
		t.Fatal(err)
	}
	for _, left := range []string{"node_modules", "dist/out.js", ".git/config"} {
		if strings.Contains(everywhere.Text, left) {
			t.Fatalf("searched %s: %s", left, everywhere.Text)
		}
	}
	if !strings.Contains(everywhere.Text, "src/a.txt:2:needle here") {
		t.Fatalf("missed the source file: %s", everywhere.Text)
	}
	named := strings.Join(everywhere.Skipped, " ")
	for _, left := range []string{".git", "node_modules", "web/dist"} {
		if !strings.Contains(" "+named+" ", " "+left+" ") {
			t.Fatalf("did not name %s among those left out: %v", left, everywhere.Skipped)
		}
	}
	// Pointed at one of them, or into it, the search reads it.
	for _, place := range []string{"node_modules", "node_modules/pkg", "web/dist"} {
		found, err := call(input{Op: "search", Path: place, Query: "needle"})
		if err != nil || !strings.Contains(found.Text, "needle in") || len(found.Skipped) != 0 {
			t.Fatalf("search inside %s: %v %v", place, found, err)
		}
	}
	// What the user cannot read is left out; the rest is still found and listed.
	if err = os.Chmod(filepath.Join(base, "locked"), 0); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(filepath.Join(base, "locked"), 0700)
	if err = os.Chmod(filepath.Join(base, "src", "closed.txt"), 0); err != nil {
		t.Fatal(err)
	}
	if _, err = os.ReadDir(filepath.Join(base, "locked")); err == nil {
		t.Skip("this user reads every directory; the mode does not close it")
	}
	closed, err := call(input{Op: "search", Path: ".", Query: "needle"})
	if err != nil || !strings.Contains(closed.Text, "src/a.txt:2:needle here") {
		t.Fatalf("an unreadable entry ended the search: %v %v", closed, err)
	}
	if strings.Contains(closed.Text, "locked") || strings.Contains(closed.Text, "closed.txt") {
		t.Fatalf("read what was closed: %s", closed.Text)
	}
	listed, err := call(input{Op: "list", Path: "."})
	if err != nil || !strings.Contains(listed.Text, "src") || !strings.Contains(listed.Text, "locked") {
		t.Fatalf("list with an unreadable directory: %v %v", listed, err)
	}
}

func TestConcurrentSaveAndInterruptedRecovery(t *testing.T) {
	root, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	must := func(e error) {
		t.Helper()
		if e != nil {
			t.Fatal(e)
		}
	}
	const name = "document.txt"
	backup := editBackup(name)
	must(root.Mkdir(path.Dir(backup), 0700))
	must(root.WriteFile(name, []byte("original"), 0600))
	f, err := root.Open(name)
	must(err)
	defer f.Close()
	info, err := f.Stat()
	must(err)
	must(root.Rename(name, backup))
	must(root.WriteFile("candidate", []byte("tool edit"), 0600))
	// An editor publishes its save after the helper has moved the expected version aside.
	must(root.WriteFile(name, []byte("new IDE save"), 0600))
	revision := fmt.Sprintf("%x", sha256.Sum256([]byte("original")))
	err = finishEdit(root, name, "candidate", backup, f, info, revision)
	if err == nil || !strings.Contains(err.Error(), backup) {
		t.Fatalf("missing recovery location: %v", err)
	}
	read := func(file string) string { t.Helper(); b, e := root.ReadFile(file); must(e); return string(b) }
	if read(name) != "new IDE save" || read(backup) != "original" {
		t.Fatal("concurrent versions lost")
	}
	// Simulate an interrupted process with the original moved aside and no replacement installed.
	must(root.Remove(name))
	id, err := run(root, input{Op: "bind"})
	must(err)
	for _, op := range []string{"read", "image"} {
		_, err = run(root, input{Op: op, Path: name, Identity: id.Text})
		if !os.IsNotExist(err) {
			t.Fatalf("%s of an absent file: %v", op, err)
		}
		if _, err = root.Lstat(name); !os.IsNotExist(err) || read(backup) != "original" {
			t.Fatalf("%s modified the interrupted edit", op)
		}
	}
	_, err = run(root, input{Op: "edit", Path: name, Identity: id.Text, Revision: revision, Old: "original", New: "next"})
	must(err)
	if read(name) != "next" {
		t.Fatal("subsequent edit failed")
	}
}
