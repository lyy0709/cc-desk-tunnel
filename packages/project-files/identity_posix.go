//go:build !windows

package main

import (
	"fmt"
	"os"
	"syscall"
)

func identity(f *os.File) (string, error) {
	s, e := f.Stat()
	if e != nil {
		return "", e
	}
	v := s.Sys().(*syscall.Stat_t)
	return fmt.Sprintf("%d:%d", v.Dev, v.Ino), nil
}

func lockEdit(f *os.File) error { return syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) }
