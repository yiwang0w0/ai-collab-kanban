package poolhistory

import runsmodels "github.com/kandev/kandev/internal/runs/models"

func clearanceForEntry(snapshot *Snapshot, entry Entry) (*runsmodels.PoolHistoryClearance, bool) {
	key, _ := (runsmodels.PoolReleaseSnapshot{WorkspaceID: snapshot.WorkspaceID, TaskID: snapshot.TaskID, EntryID: entry.ID}).DispatchKey()
	var match *runsmodels.PoolHistoryClearance
	present := false
	for i := range snapshot.Clearances {
		candidate := &snapshot.Clearances[i]
		if candidate.DispatchKey != key {
			continue
		}
		if present {
			return nil, true
		}
		present = true
		release, valid := candidate.Release()
		if valid && candidate.WorkspaceID == snapshot.WorkspaceID && releaseMatchesEntry(release, snapshot.TaskID, entry) {
			match = candidate
		}
	}
	return match, present
}

func projectClearance(item Item, clearance *runsmodels.PoolHistoryClearance) Item {
	release, _ := clearance.Release()
	item.RunID, item.PlannedAgentProfileID = clearance.RunID, release.AgentProfileID
	item.QueuedAt = &clearance.RequestedAt
	item.State, item.Reason, item.Current = stateUnknown, "history_cleaned", false
	return item
}
