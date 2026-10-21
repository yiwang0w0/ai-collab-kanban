package service

import (
	"context"
	"errors"
	"time"

	"github.com/kandev/kandev/internal/task/models"
	"github.com/kandev/kandev/internal/task/statussummary"
)

func (s *Service) reconcilePoolSummaries(ctx context.Context, tasks []*models.Task, summaries map[string]*statussummary.TaskStatusSummary) (map[string]*statussummary.TaskStatusSummary, error) {
	observations := s.loadPoolSummaryObservations(ctx, tasks)
	var combined error
	for _, task := range tasks {
		if task == nil || summaries[task.ID] == nil || !observations[task.ID].observed {
			continue
		}
		updated, err := s.reconcilePoolSummary(ctx, task, summaries[task.ID], observations[task.ID])
		if err != nil {
			s.logSummaryRepairFailure(task.ID, "pool execution", err)
			combined = errors.Join(combined, err)
		}
		summaries[task.ID] = updated
	}
	return summaries, combined
}

func (s *Service) reconcilePoolSummary(ctx context.Context, task *models.Task, current *statussummary.TaskStatusSummary, observation poolSummaryObservation) (*statussummary.TaskStatusSummary, error) {
	for attempt := 0; attempt < maxSummaryReconcileAttempts; attempt++ {
		if current == nil {
			return nil, observation.err
		}
		next := *current
		next.PoolExecution = observation.value
		if observation.err != nil {
			next.PoolExecution = statussummary.UnavailablePoolExecution(current.PoolExecution)
		}
		if next.SemanticEqual(*current) {
			return current, observation.err
		}
		next.Revision, next.UpdatedAt = current.Revision+1, time.Now().UTC()
		accepted, err := s.statusSummaries.CompareAndUpdateTaskStatusSummary(ctx, &statussummary.StoredTaskStatusSummary{
			TaskID: task.ID, WorkspaceID: task.WorkspaceID, Summary: next,
		})
		if err != nil {
			return nil, err
		}
		if accepted {
			s.publishReconciledSummary(ctx, task, next)
			return &next, observation.err
		}
		rows, err := s.statusSummaries.LoadTaskStatusSummaries(ctx, []string{task.ID})
		if err != nil {
			return nil, err
		}
		current = rows[task.ID]
		observation = s.loadPoolSummaryObservations(ctx, []*models.Task{task})[task.ID]
		if !observation.observed {
			return current, observation.err
		}
	}
	return nil, errors.New("pool_summary_reconcile_exhausted")
}
