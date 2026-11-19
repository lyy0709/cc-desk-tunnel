package main

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

func identity(f *os.File) (string, error) {
	var v syscall.ByHandleFileInformation
	e := syscall.GetFileInformationByHandle(syscall.Handle(f.Fd()), &v)
	return fmt.Sprintf("%d:%d:%d", v.VolumeSerialNumber, v.FileIndexHigh, v.FileIndexLow), e
}

var lockFileEx = syscall.NewLazyDLL("kernel32.dll").NewProc("LockFileEx")

func lockEdit(f *os.File) error {
	var region syscall.Overlapped
	ok, _, err := lockFileEx.Call(f.Fd(), 3, 0, 0xffffffff, 0, uintptr(unsafe.Pointer(&region)))
	if ok == 0 {
		return err
	}
	return nil
}
