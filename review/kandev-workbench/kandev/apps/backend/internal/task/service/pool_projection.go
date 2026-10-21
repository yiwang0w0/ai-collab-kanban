package service

import (
	"context"
	"time"

	"github.com/kandev/kandev/internal/task/poolview"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
)

type poolProjectionReader interface {
	ReadPoolProjectionSnapshot(context.Context, string, poolview.Query) (*poolview.Snapshot, error)
}

func (s *Service) GetPoolProjection(ctx context.Context, workspaceID string, limit int, cursor string) (*poolview.Page, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if workspaceID == "" {
		return nil, repoerrors.ErrWorkspaceNotFound
	}
	if err := s.authorizeWorkspaceID(ctx, workspaceID); err != nil {
		return nil, err
	}
	query, err := poolview.ParseQuery(workspaceID, limit, cursor)
	if err != nil {
		return nil, err
	}
	reader, ok := s.tasks.(poolProjectionReader)
	if !ok {
		return nil, poolview.ErrUnavailable
	}
	snapshot, err := reader.ReadPoolProjectionSnapshot(ctx, workspaceID, query)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !validPoolProjectionSnapshot(snapshot, workspaceID, query) {
		return nil, poolview.ErrUnavailable
	}
	return poolview.Project(snapshot)
}

func validPoolProjectionSnapshot(snapshot *poolview.Snapshot, workspaceID string, query poolview.Query) bool {
	if snapshot == nil || snapshot.WorkspaceID != workspaceID || len(snapshot.Cards) > query.Limit {
		return false
	}
	previous := query.After
	for _, card := range snapshot.Cards {
		if card.WorkspaceID != workspaceID || card.TaskID == "" || len(card.TaskID) > 256 || card.TaskID <= previous {
			return false
		}
		previous = card.TaskID
	}
	return true
}
