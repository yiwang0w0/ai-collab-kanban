package poolhistory

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/steptelemetry"
)

func Project(snapshot *Snapshot) (*Page, error) {
	if snapshot == nil {
		return nil, ErrUnavailable
	}
	page := &Page{TaskID: snapshot.TaskID, Items: make([]Item, 0, len(snapshot.Entries))}
	for _, selection := range snapshot.Selections {
		page.Items = append(page.Items, projectSelection(snapshot, selection))
	}
	if snapshot.HasMore && len(snapshot.Selections) != 0 {
		cursor, err := encodeCursor(snapshot.TaskID, snapshot.Selections[len(snapshot.Selections)-1])
		if err != nil {
			return nil, err
		}
		page.NextCursor = cursor
	}
	encoded, err := json.Marshal(page)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(encoded)
	page.SnapshotVersion = hex.EncodeToString(digest[:])
	return page, nil
}

func projectEntry(snapshot *Snapshot, entry Entry) Item {
	item := Item{EntryID: entry.ID, State: stateUnknown, Reason: "binding_unverified"}
	if !validEntry(entry) {
		return item
	}
	item.ReleasedAt = &entry.OccurredAt
	item.PlannedAgentProfileID = entry.PlannedProfile
	if snapshot.Incomplete {
		item.Reason = "history_evidence_limit"
		return item
	}
	valid, invalid := runsForEntry(snapshot, entry)
	if clearance, present := clearanceForEntry(snapshot, entry); present {
		if clearance != nil && len(valid) == 0 && !invalid {
			return projectClearance(item, clearance)
		}
		return item
	}
	if len(valid) == 0 && !invalid {
		if !snapshot.PolicyActivatedAt.IsZero() && !entry.OccurredAt.After(snapshot.PolicyActivatedAt) {
			item.Reason = "legacy_dispatch_unverified"
			return item
		}
		item.State, item.Reason = "released", ""
		return item
	}
	if len(valid) != 1 {
		return item
	}
	run := valid[0]
	item.RunID, item.PlannedAgentProfileID = run.ID, run.AgentProfileID
	item.QueuedAt = &run.RequestedAt
	if run.Status == "cancelled" {
		return projectWithdrawal(snapshot, entry, run, item)
	}
	if run.Status == runsmodels.RunStatusQueued {
		item.State, item.Reason = "queued", ""
		for _, count := range snapshot.ClaimCounts {
			if count.RunID == run.ID && count.Total != 0 {
				return projectRequeuedPending(snapshot, entry, run, item)
			}
		}
	} else {
		item.Reason = "execution_evidence_not_loaded"
	}
	return item
}

func validEntry(entry Entry) bool {
	return entry.ContractVersion == steptelemetry.ContractVersion && entry.ActorKind == "human" &&
		entry.ActorID != "" && len(entry.ActorID) <= 256 && !entry.OccurredAt.IsZero()
}

func runsForEntry(snapshot *Snapshot, entry Entry) ([]*runsmodels.Run, bool) {
	valid, invalid := make([]*runsmodels.Run, 0, 2), false
	key, _ := (runsmodels.PoolReleaseSnapshot{WorkspaceID: snapshot.WorkspaceID, TaskID: snapshot.TaskID, EntryID: entry.ID}).DispatchKey()
	for _, run := range snapshot.Runs {
		if run == nil || run.IdempotencyKey == nil || *run.IdempotencyKey != key {
			continue
		}
		var payload struct {
			Release runsmodels.PoolReleaseSnapshot `json:"pool_release"`
		}
		if json.Unmarshal([]byte(run.Payload), &payload) != nil || !releaseMatchesEntry(payload.Release, snapshot.TaskID, entry) ||
			!payload.Release.MatchesRun(run) || run.RequestedAt.IsZero() || len(run.ID) > 256 || len(run.AgentProfileID) > 256 {
			invalid = true
			continue
		}
		valid = append(valid, run)
	}
	return valid, invalid
}

func releaseMatchesEntry(release runsmodels.PoolReleaseSnapshot, taskID string, entry Entry) bool {
	return release.TaskID == taskID && release.EntryID == entry.ID && release.WorkflowID == entry.WorkflowID &&
		release.WorkflowStepID == entry.StepID && release.ActorID == entry.ActorID && release.ReleasedAt.Equal(entry.OccurredAt) &&
		release.AgentProfileID != "" && len(release.AgentProfileID) <= 256
}
