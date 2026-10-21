package poolview

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"

	"github.com/kandev/kandev/internal/task/poolhistory"
)

func Project(snapshot *Snapshot) (*Page, error) {
	if snapshot == nil {
		return nil, ErrUnavailable
	}
	page := &Page{WorkspaceID: snapshot.WorkspaceID, Items: make([]Card, 0, len(snapshot.Cards))}
	for _, card := range snapshot.Cards {
		projected, err := projectCard(snapshot, card)
		if err != nil {
			return nil, err
		}
		page.Items = append(page.Items, projected)
	}
	if snapshot.HasMore && len(page.Items) != 0 {
		encoded, err := json.Marshal(Cursor{Version: 1, WorkspaceID: snapshot.WorkspaceID,
			AfterTaskID: page.Items[len(page.Items)-1].TaskID})
		if err != nil {
			return nil, err
		}
		page.NextCursor = base64.RawURLEncoding.EncodeToString(encoded)
	}
	encoded, err := json.Marshal(page)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(encoded)
	page.SnapshotVersion = hex.EncodeToString(digest[:])
	return page, nil
}

func projectCard(snapshot *Snapshot, card Card) (Card, error) {
	card.PoolExecution = nil
	if history := snapshot.Histories[card.TaskID]; history != nil {
		if history.TaskID != card.TaskID || history.WorkspaceID != snapshot.WorkspaceID {
			return Card{}, ErrUnavailable
		}
		projected, err := poolhistory.Project(history)
		if err != nil || len(projected.Items) != 1 || len(history.Entries) != 1 {
			return Card{}, ErrUnavailable
		}
		card.PoolExecution = &projected.Items[0]
		entry := history.Entries[0]
		if entry.ID != history.LatestEntryID || entry.WorkflowID != card.WorkflowID || entry.StepID != card.WorkflowStepID {
			card.PoolExecution.State, card.PoolExecution.Reason, card.PoolExecution.Current = stateUnknown, "current_stage_unverified", false
		}
	}
	context, ok := snapshot.Contexts[card.TaskID]
	if !ok {
		card.Eligibility = Eligibility{State: stateUnknown, Reason: "context_unavailable"}
		return card, nil
	}
	card.Relations, card.Eligibility = context.Relations, projectEligibility(card, context)
	return card, nil
}
