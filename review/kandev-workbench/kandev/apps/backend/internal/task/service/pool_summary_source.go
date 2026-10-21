package service

import (
	"context"
	"errors"
	"time"

	"github.com/kandev/kandev/internal/task/models"
	"github.com/kandev/kandev/internal/task/poolhistory"
	"github.com/kandev/kandev/internal/task/poolview"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
	"github.com/kandev/kandev/internal/task/statussummary"
)

type poolSummaryReader interface {
	PoolHistoryWorkspace(context.Context, string) (string, error)
	ReadPoolSummarySnapshot(context.Context, string, []string) (*poolview.Snapshot, error)
}

type poolSummaryObservation struct {
	value    *statussummary.PoolExecutionSummary
	observed bool
	err      error
}

// GetPoolExecutionSummary 供原生投影器按已提交资料重建单卡，不启动执行或回填账本。
func (s *Service) GetPoolExecutionSummary(ctx context.Context, taskID string) (*statussummary.PoolExecutionSummary, error) {
	reader, supported := s.tasks.(poolSummaryReader)
	if !supported {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	workspaceID, err := reader.PoolHistoryWorkspace(ctx, taskID)
	if err != nil {
		return nil, err
	}
	if workspaceID == "" {
		return nil, repoerrors.ErrTaskNotFound
	}
	if err := s.authorizeWorkspaceID(ctx, workspaceID); err != nil {
		return nil, err
	}
	rows, err := s.readPoolSummaryGroup(ctx, reader, workspaceID, []string{taskID})
	if errors.Is(err, repoerrors.ErrPoolStorageUnsupported) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	value, found := rows[taskID]
	if !found {
		return nil, repoerrors.ErrTaskNotFound
	}
	return value, nil
}

func (s *Service) readPoolSummaryGroup(ctx context.Context, reader poolSummaryReader, workspaceID string, ids []string) (map[string]*statussummary.PoolExecutionSummary, error) {
	snapshot, err := reader.ReadPoolSummarySnapshot(ctx, workspaceID, ids)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !validPoolProjectionSnapshot(snapshot, workspaceID, poolview.Query{Limit: len(ids)}) {
		return nil, poolview.ErrUnavailable
	}
	allowed := make(map[string]bool, len(ids))
	for _, id := range ids {
		allowed[id] = true
	}
	for _, card := range snapshot.Cards {
		if !allowed[card.TaskID] {
			return nil, poolview.ErrUnavailable
		}
	}
	page, err := poolview.Project(snapshot)
	if err != nil {
		return nil, err
	}
	result := make(map[string]*statussummary.PoolExecutionSummary, len(page.Items))
	for _, card := range page.Items {
		result[card.TaskID] = nil
		if card.PoolExecution != nil {
			value := statussummary.PoolExecutionSummary(*card.PoolExecution)
			result[card.TaskID] = &value
		}
	}
	return result, nil
}

func (s *Service) loadPoolSummaryObservations(ctx context.Context, tasks []*models.Task) map[string]poolSummaryObservation {
	reader, supported := s.tasks.(poolSummaryReader)
	if !supported {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	groups := make(map[string][]string)
	seen := make(map[string]bool, len(tasks))
	for _, task := range tasks {
		if task != nil && task.ID != "" && task.WorkspaceID != "" && !seen[task.ID] {
			seen[task.ID] = true
			groups[task.WorkspaceID] = append(groups[task.WorkspaceID], task.ID)
		}
	}
	result := make(map[string]poolSummaryObservation)
	for workspaceID, ids := range groups {
		for start := 0; start < len(ids); start += poolhistory.MaxItems {
			batch := ids[start:min(start+poolhistory.MaxItems, len(ids))]
			values, err := s.readPoolSummaryGroup(ctx, reader, workspaceID, batch)
			if errors.Is(err, repoerrors.ErrPoolStorageUnsupported) {
				continue
			}
			for _, id := range batch {
				value, found := values[id]
				result[id] = poolSummaryObservation{value: value, observed: found || err != nil, err: err}
			}
		}
	}
	return result
}
