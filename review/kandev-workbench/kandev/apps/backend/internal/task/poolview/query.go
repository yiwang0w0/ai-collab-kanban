package poolview

import (
	"bytes"
	"encoding/base64"
	"encoding/json"

	"github.com/kandev/kandev/internal/task/poolhistory"
)

func ParseQuery(workspaceID string, limit int, cursor string) (Query, error) {
	query := Query{Limit: limit}
	if workspaceID == "" || len(workspaceID) > 256 || limit < 0 || limit > poolhistory.MaxItems || len(cursor) > 1024 {
		return Query{}, ErrInvalidQuery
	}
	if query.Limit == 0 {
		query.Limit = poolhistory.MaxItems
	}
	if cursor == "" {
		return query, nil
	}
	encoded, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return Query{}, ErrInvalidQuery
	}
	var position Cursor
	if json.Unmarshal(encoded, &position) != nil || !position.validFor(workspaceID) {
		return Query{}, ErrInvalidQuery
	}
	canonical, err := json.Marshal(position)
	if err != nil || !bytes.Equal(encoded, canonical) {
		return Query{}, ErrInvalidQuery
	}
	query.After = position.AfterTaskID
	return query, nil
}

func (position Cursor) validFor(workspaceID string) bool {
	return position.Version == 1 && position.WorkspaceID == workspaceID &&
		position.AfterTaskID != "" && len(position.AfterTaskID) <= 256
}
