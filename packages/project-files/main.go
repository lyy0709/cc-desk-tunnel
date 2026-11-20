// project-files resolves every filesystem operation through an open directory handle.
package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const page = 12000
const textPage = 32000
const textBudget = 90000
const imagePage = 64 << 10
const maxEdit = 4 << 20

type input struct {
	Op, Path, Query, Old, New, Identity, Revision string
	Offset                                        int
	Line                                          int
	All                                           bool
}
type result struct {
	Text     string   `json:"text"`
	Revision string   `json:"revision,omitempty"`
	Next     int      `json:"next,omitempty"`
	Skipped  []string `json:"skipped,omitempty"`
	Error    string   `json:"error,omitempty"`
	Offset   int      `json:"offset,omitempty"`
}

// Directories a search leaves out unless it is pointed at or into one: version control, installed dependencies
// and build output. Reading every file of them takes longer than a search may, and what they hold is seldom what
// is looked for. The result names the ones left out.
var unsearched = map[string]bool{
	".git": true, "node_modules": true, ".venv": true, "venv": true, "__pycache__": true,
	"target": true, "dist": true, ".next": true, ".gradle": true, ".cache": true,
}

func bad(message string) error { return errors.New(message) }
func run(root *os.Root, q input) (result, error) {
	dir, err := root.Open(".")
	if err != nil {
		return result{}, err
	}
	defer dir.Close()
	id, err := identity(dir)
	if err != nil {
		return result{}, err
	}
	if q.Op == "bind" {
		return result{Text: id}, nil
	}
	if q.Identity != id {
		return result{}, bad("project directory changed; select it again")
	}
	name := q.Path
	if name == "" {
		name = "."
	}
	if !fs.ValidPath(name) || strings.ContainsAny(name, "\\:\x00") || !filepath.IsLocal(filepath.FromSlash(name)) || q.Offset < 0 || q.Line < 0 {
		return result{}, bad("invalid relative path or offset")
	}
	// Only a write may recover the original left by an interrupted edit.
	if q.Op == "edit" || q.Op == "create" {
		if _, e := root.Lstat(name); errors.Is(e, fs.ErrNotExist) {
			backup := editBackup(name)
			if saved, e := root.Lstat(backup); e == nil && saved.Mode().IsRegular() {
				e = withEditLock(root, path.Dir(backup), func() error {
					if e := root.Link(backup, name); e != nil {
						return fmt.Errorf("interrupted edit: inspect %s", backup)
					}
					return root.Remove(backup)
				})
				if e != nil {
					return result{}, e
				}
			}
		}
	}
	switch q.Op {
	case "list", "search":
		if q.Op == "search" && q.Query == "" {
			return result{}, bad("empty search")
		}
		var lines, skipped []string
		consumed, count := 0, 0
		inside := false
		for _, part := range strings.Split(name, "/") {
			inside = inside || unsearched[part]
		}
		add := func(line string) error {
			if count >= q.Offset {
				if consumed+len(line) > page && len(lines) > 0 {
					return io.EOF
				}
				if len(line) > page {
					line = string([]rune(line)[:min(len([]rune(line)), page/4)]) + "…"
				}
				lines = append(lines, line)
				consumed += len(line) + 1
			}
			count++
			return nil
		}
		err = fs.WalkDir(root.FS(), name, func(p string, d fs.DirEntry, e error) error {
			if e != nil {
				// The directory asked for has to be readable. One below it that is not is left out.
				if p == name {
					return e
				}
				if d != nil && d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			if d.Type()&fs.ModeSymlink != 0 {
				return nil
			}
			if q.Op == "list" {
				if p == name {
					return nil
				}
				e = add(p)
				if e != nil {
					return e
				}
				if d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			if d.IsDir() {
				if p != name && !inside && unsearched[d.Name()] {
					if len(skipped) < 20 {
						skipped = append(skipped, p)
					}
					return fs.SkipDir
				}
				return nil
			}
			if !d.Type().IsRegular() {
				return nil
			}
			// A file that cannot be opened or read, or went away meanwhile, does not end the search.
			f, e := root.Open(p)
			if e != nil {
				return nil
			}
			defer f.Close()
			info, e := f.Stat()
			if e != nil || !info.Mode().IsRegular() || info.Size() > maxEdit {
				return nil
			}
			b, e := io.ReadAll(io.LimitReader(f, maxEdit+1))
			if e != nil {
				return nil
			}
			if !utf8.Valid(b) || strings.IndexByte(string(b), 0) >= 0 {
				return nil
			}
			for i, line := range strings.Split(string(b), "\n") {
				if strings.Contains(line, q.Query) {
					if e = add(fmt.Sprintf("%s:%d:%s", p, i+1, line)); e != nil {
						return e
					}
				}
			}
			return nil
		})
		out := result{Text: strings.Join(lines, "\n"), Skipped: skipped}
		if errors.Is(err, io.EOF) {
			out.Next = count
			err = nil
		}
		return out, err
	case "create":
		temp, e := tempName(name)
		if e != nil {
			return result{}, e
		}
		f, e := root.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0666)
		if e != nil {
			return result{}, e
		}
		defer root.Remove(temp)
		_, e = io.WriteString(f, q.New)
		closed := f.Close()
		if e != nil {
			return result{}, e
		}
		if closed != nil {
			return result{}, closed
		}
		// Publish only after writing succeeds. Link fails if an editor created the target meanwhile.
		return result{Text: name, Revision: fmt.Sprintf("%x", sha256.Sum256([]byte(q.New)))}, root.Link(temp, name)
	case "read", "image", "edit":
		f, e := root.Open(name)
		if e != nil {
			return result{}, e
		}
		defer f.Close()
		info, e := f.Stat()
		if e != nil {
			return result{}, e
		}
		if !info.Mode().IsRegular() {
			return result{}, bad("regular files only")
		}
		revision := fmt.Sprintf("%d:%d", info.Size(), info.ModTime().UnixNano())
		if q.Op != "image" && info.Size() <= maxEdit {
			hash := sha256.New()
			if _, e = io.Copy(hash, io.NewSectionReader(f, 0, info.Size())); e != nil {
				return result{}, e
			}
			revision = hex.EncodeToString(hash.Sum(nil))
		}
		if q.Op == "edit" && q.Revision != revision {
			return result{}, bad("edit conflict: file changed since read")
		}
		if q.Op == "image" && info.Size() > 20<<20 {
			return result{}, bad("image exceeds 20 MiB")
		}
		if q.Op == "image" {
			b := make([]byte, imagePage)
			n, e := f.ReadAt(b, int64(q.Offset))
			if e != nil && e != io.EOF {
				return result{}, e
			}
			r := result{Text: base64.StdEncoding.EncodeToString(b[:n]), Revision: revision}
			if int64(q.Offset+n) < info.Size() {
				r.Next = q.Offset + n
			}
			return r, nil
		}
		if q.Op == "read" {
			offset := min(int64(q.Offset), info.Size())
			if q.Line > 0 {
				offset = 0
				reader := bufio.NewReader(f)
				for line := 1; line < q.Line; {
					part, err := reader.ReadSlice('\n')
					offset += int64(len(part))
					if err == io.EOF {
						break
					}
					if err != nil && err != bufio.ErrBufferFull {
						return result{}, err
					}
					if err == nil {
						line++
					}
				}
			}
			// A byte offset may point into a multibyte character. Start at that character, never in its middle.
			for back := 0; offset > 0 && offset < info.Size() && back < utf8.UTFMax; back++ {
				one := []byte{0}
				if _, e = f.ReadAt(one, offset); e != nil {
					return result{}, e
				}
				if utf8.RuneStart(one[0]) {
					break
				}
				offset--
			}
			b := make([]byte, textPage+utf8.UTFMax)
			n, e := f.ReadAt(b, offset)
			if e != nil && e != io.EOF {
				return result{}, e
			}
			b = b[:n]
			end := min(len(b), textPage)
			for end < len(b) && end > 0 && !utf8.RuneStart(b[end]) {
				end--
			}
			b = b[:end]
			if !utf8.Valid(b) || bytes.IndexByte(b, 0) >= 0 {
				return result{}, bad("UTF-8 text only")
			}
			// Keep the JSON-escaped reply within the transport limit, including control characters and HTML escapes.
			cost := 0
			for at, r := range string(b) {
				size := utf8.RuneLen(r)
				switch r {
				case '\n', '\r', '\t', '\b', '\f', '"', '\\':
					size = 2
				case '<', '>', '&', '\u2028', '\u2029':
					size = 6
				default:
					if r < 32 {
						size = 6
					}
				}
				if cost+size > textBudget {
					b = b[:at]
					break
				}
				cost += size
			}
			out := result{Revision: revision, Offset: int(offset)}
			if offset+int64(len(b)) < info.Size() {
				// Complete lines make the page easier to use as an exact edit excerpt.
				if at := bytes.LastIndexByte(b, '\n'); at >= 0 {
					b = b[:at+1]
				}
				out.Next = int(offset) + len(b)
			}
			out.Text = string(b)
			return out, nil
		}
		b, e := io.ReadAll(io.LimitReader(f, maxEdit+1))
		if e != nil {
			return result{}, e
		}
		count := strings.Count(string(b), q.Old)
		if q.Revision != fmt.Sprintf("%x", sha256.Sum256(b)) || len(b) > maxEdit || !utf8.Valid(b) || q.Old == "" || count == 0 || (count != 1 && !q.All) {
			return result{}, bad("edit conflict: read the current file and select unique text")
		}
		link, e := root.Lstat(name)
		if e != nil || !os.SameFile(info, link) {
			return result{}, bad("edit conflict")
		}
		if !q.All {
			count = 1
		}
		// Check expansion before allocating: replacing a short repeated excerpt can otherwise exhaust memory.
		if len(b)+count*(len(q.New)-len(q.Old)) > maxEdit {
			return result{}, bad("edited file exceeds 4 MiB")
		}
		next := strings.Replace(string(b), q.Old, q.New, count)
		temp, e := tempName(name)
		if e != nil {
			return result{}, e
		}
		tmp, e := root.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return result{}, e
		}
		defer root.Remove(temp)
		_, e = io.WriteString(tmp, next)
		if e == nil {
			e = tmp.Chmod(info.Mode().Perm())
		}
		ce := tmp.Close()
		if e != nil {
			return result{}, e
		}
		if ce != nil {
			return result{}, ce
		}
		if e = lockEdit(f); e != nil {
			return result{}, bad("edit conflict: file is busy")
		}
		return result{Text: name, Revision: fmt.Sprintf("%x", sha256.Sum256([]byte(next)))}, publishEdit(root, name, temp, f, info, q.Revision)
	}
	return result{}, bad("unknown file operation")
}

// The recovery directory is private, next to the target and predictable across a crash.
func editBackup(name string) string {
	base := path.Base(name)
	key := sha256.Sum256([]byte(base))
	return path.Join(path.Dir(name), fmt.Sprintf(".ccdt-edit-%x", key), "original")
}

func withEditLock(root *os.Root, directory string, action func() error) error {
	if err := root.Mkdir(directory, 0700); err != nil && !errors.Is(err, fs.ErrExist) {
		return err
	}
	d, err := root.Lstat(directory)
	if err != nil || !d.IsDir() {
		return bad("edit conflict: invalid recovery directory")
	}
	name := path.Join(directory, "lock")
	f, err := root.OpenFile(name, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := lockEdit(f); err != nil {
		return bad("edit conflict: another save is in progress")
	}
	opened, err := f.Stat()
	listed, le := root.Lstat(name)
	if err != nil || le != nil || !opened.Mode().IsRegular() || !os.SameFile(opened, listed) {
		return bad("edit conflict: recovery lock changed")
	}
	defer root.Remove(directory) // A retained original keeps its directory.
	defer root.Remove(name)
	return action()
}

func publishEdit(root *os.Root, name, temp string, original *os.File, info os.FileInfo, revision string) error {
	backup := editBackup(name)
	return withEditLock(root, path.Dir(backup), func() error {
		if _, err := root.Lstat(backup); !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("edit conflict: inspect retained version at %s", backup)
		}
		current, err := root.Lstat(name)
		if err != nil || !os.SameFile(info, current) {
			return bad("edit conflict: file was replaced")
		}
		if err := root.Rename(name, backup); err != nil {
			return err
		}
		return finishEdit(root, name, temp, backup, original, info, revision)
	})
}

func finishEdit(root *os.Root, name, temp, backup string, original *os.File, info os.FileInfo, revision string) error {
	saved, err := root.Lstat(backup)
	if err == nil && os.SameFile(info, saved) && info.Size() == saved.Size() && info.ModTime().Equal(saved.ModTime()) {
		hash := sha256.New()
		_, err = io.Copy(hash, io.NewSectionReader(original, 0, info.Size()))
		if err == nil && hex.EncodeToString(hash.Sum(nil)) == revision {
			// Link publishes only into an empty name. An IDE save always wins this race.
			if err = root.Link(temp, name); err == nil {
				return root.Remove(backup)
			}
		}
	}
	if err := root.Link(backup, name); err != nil {
		return fmt.Errorf("edit conflict: retained displaced version at %s", backup)
	}
	if err := root.Remove(backup); err != nil {
		return fmt.Errorf("edit conflict: restored file, retained copy at %s", backup)
	}
	return bad("edit conflict: file changed before replacement")
}

func tempName(name string) (string, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	return path.Join(path.Dir(name), ".ccdt-"+hex.EncodeToString(id[:])), nil
}
func main() {
	out := result{}
	var q input
	if len(os.Args) != 2 || json.NewDecoder(bufio.NewReader(io.LimitReader(os.Stdin, 256<<10))).Decode(&q) != nil {
		out.Error = "invalid file request"
	} else {
		root, e := os.OpenRoot(os.Args[1])
		if e == nil {
			out, e = run(root, q)
			root.Close()
		}
		if e != nil {
			var pe *fs.PathError
			if errors.As(e, &pe) {
				out.Error = pe.Err.Error()
			} else {
				out.Error = e.Error()
			}
		}
	}
	json.NewEncoder(os.Stdout).Encode(out)
}
