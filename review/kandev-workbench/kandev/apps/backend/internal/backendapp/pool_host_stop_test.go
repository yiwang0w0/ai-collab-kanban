package backendapp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	gorillaws "github.com/gorilla/websocket"
	ws "github.com/kandev/kandev/pkg/websocket"
)

func (f *poolBinaryHost) stopTask(ctx context.Context, taskID string) error {
	if f.stoppedTasks[taskID] {
		return nil
	}
	message, err := f.sendWS(ctx, ws.ActionOrchestratorStop, map[string]any{
		"task_id": taskID, "reason": "私有宿主模拟验收", "force": true,
	})
	if err != nil {
		return err
	}
	if message.Type != ws.MessageTypeResponse {
		return fmt.Errorf("原生停止没有确认：%s", message.Payload)
	}
	f.stoppedTasks[taskID] = true
	return nil
}

func (f *poolBinaryHost) sendWS(ctx context.Context, action string, data any) (*ws.Message, error) {
	base, err := url.Parse(f.baseURL)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, f.baseURL, nil)
	if err != nil {
		return nil, err
	}
	for _, cookie := range f.client.Jar.Cookies(base) {
		request.AddCookie(cookie)
	}
	header := http.Header{"Cookie": request.Header.Values("Cookie"), "Origin": []string{f.baseURL}}
	dialer := gorillaws.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, response, err := dialer.DialContext(ctx, "ws"+strings.TrimPrefix(f.baseURL, "http")+"/ws", header)
	if response != nil && response.Body != nil {
		defer response.Body.Close()
	}
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if err := conn.SetReadDeadline(time.Now().Add(15 * time.Second)); err != nil {
		return nil, err
	}
	id := uuid.NewString()
	payload, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	if err := conn.WriteJSON(ws.Message{ID: id, Type: ws.MessageTypeRequest, Action: action, Payload: payload}); err != nil {
		return nil, err
	}
	for {
		var message ws.Message
		if err := conn.ReadJSON(&message); err != nil {
			return nil, err
		}
		if message.ID != id {
			continue
		}
		return &message, nil
	}
}
