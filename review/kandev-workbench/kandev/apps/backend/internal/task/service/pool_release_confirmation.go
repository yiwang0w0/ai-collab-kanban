package service

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
)

var errInvalidPoolReleaseConfirmation = errors.New("pool_release_invalid_confirmation")

// UnmarshalJSON 对各传输统一拒绝确认契约之外的字段，不将调用者自报身份当作批准。
func (c *PoolReleaseConfirmation) UnmarshalJSON(data []byte) error {
	type confirmation PoolReleaseConfirmation
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var decoded confirmation
	if err := decoder.Decode(&decoded); err != nil {
		return errInvalidPoolReleaseConfirmation
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errInvalidPoolReleaseConfirmation
	}
	*c = PoolReleaseConfirmation(decoded)
	return nil
}
