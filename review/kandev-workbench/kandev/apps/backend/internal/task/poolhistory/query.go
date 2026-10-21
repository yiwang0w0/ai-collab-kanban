package poolhistory

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
)

func ParseQuery(taskID string, limit int, cursor string) (Query, error) {
	query := Query{Limit: limit}
	if taskID == "" || len(taskID) > 256 || limit < 0 || limit > MaxItems || len(cursor) > 1024 {
		return Query{}, ErrInvalidQuery
	}
	if query.Limit == 0 {
		query.Limit = MaxItems
	}
	if cursor == "" {
		return query, nil
	}
	encoded, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return Query{}, ErrInvalidQuery
	}
	var position Cursor
	if json.Unmarshal(encoded, &position) != nil || !position.validFor(taskID) {
		return Query{}, ErrInvalidQuery
	}
	canonical, err := json.Marshal(position)
	if err != nil || !bytes.Equal(encoded, canonical) {
		return Query{}, ErrInvalidQuery
	}
	query.Before = position.EntryID
	query.Position = &position
	return query, nil
}

func (position Cursor) validFor(taskID string) bool {
	return position.Version == 1 && position.TaskID == taskID && position.EntryID > 0 &&
		len(position.RunID) <= 256 && len(position.ClaimID) <= 256 &&
		(position.ClaimID != "") == (position.ClaimedAt != nil) &&
		(position.ClaimID == "" || position.RunID != "") &&
		(position.ClaimedAt == nil || !position.ClaimedAt.IsZero())
}

func encodeCursor(taskID string, selection Selection) (string, error) {
	encoded, err := json.Marshal(Cursor{Version: 1, TaskID: taskID, EntryID: selection.EntryID,
		RunID: selection.RunID, ClaimID: selection.ClaimID, ClaimedAt: selection.ClaimedAt})
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(encoded), nil
}
