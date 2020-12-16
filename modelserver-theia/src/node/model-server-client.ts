/********************************************************************************
 * Copyright (c) 2019 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * https://www.eclipse.org/legal/epl-2.0, or the MIT License which is
 * available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: EPL-2.0 OR MIT
 ********************************************************************************/
import { inject, injectable, optional } from 'inversify';
import * as WebSocket from 'ws';

import {
    DEFAULT_LAUNCH_OPTIONS,
    LaunchOptions,
    Model,
    ModelServerClient,
    ModelServerCommand,
    ModelServerMessage,
    ModelServerPaths,
    ModelServerSubscriptionClient,
    RequestBody,
    Response,
    ResponseBody,
    ServerConfiguration
} from '../common';
import { RestClient } from './rest-client';

@injectable()
export class DefaultModelServerClient implements ModelServerClient {

    @inject(LaunchOptions) @optional() protected readonly options: LaunchOptions = DEFAULT_LAUNCH_OPTIONS;

    protected restClient: RestClient<ResponseBody>;
    protected openSockets: Map<string, WebSocket> = new Map();
    protected baseUrl: string;
    protected subscriptionClient: ModelServerSubscriptionClient;

    async initialize(): Promise<boolean> {
        this.prepareBaseUrl();
        this.restClient = new RestClient(this.baseUrl);
        return true;
    }

    prepareBaseUrl(): void {
        this.baseUrl = `http://${this.options.hostname}:${this.options.serverPort}/${this.options.baseURL}`;
        if (!this.baseUrl.endsWith('/')) {
            this.baseUrl = this.baseUrl + '/';
        }
    }

    async get(modelUri: string): Promise<Response<string>> {
        const response = await this.restClient.get(`${ModelServerPaths.MODEL_CRUD}?modeluri=${modelUri}`);
        return response.mapBody(ResponseBody.asString);
    }

    async getAll(): Promise<Response<Model[]>> {
        const response = await this.restClient.get(ModelServerPaths.MODEL_CRUD);
        return response.mapBody(ResponseBody.asModelArray);
    }

    async getModelUris(): Promise<Response<string[]>> {
        const response = await this.restClient.get(ModelServerPaths.MODEL_URIS);
        return response.mapBody(ResponseBody.asStringArray);
    }

    async getElementById(modelUri: string, elementId: string): Promise<Response<string>> {
        const response = await this.restClient.get(`${ModelServerPaths.MODEL_ELEMENT}?modeluri=${modelUri}&elementid=${elementId}`);
        return response.mapBody(ResponseBody.asString);
    }

    async getElementByName(modelUri: string, elementName: string): Promise<Response<string>> {
        const response = await this.restClient.get(`${ModelServerPaths.MODEL_ELEMENT}?modeluri=${modelUri}&elementname=${elementName}`);
        return response.mapBody(ResponseBody.asString);
    }

    async delete(modelUri: string): Promise<Response<boolean>> {
        const response = await this.restClient.remove(`${ModelServerPaths.MODEL_CRUD}?modeluri=${modelUri}`);
        return response.mapBody(ResponseBody.isSuccess);
    }

    async undo(modelUri: string): Promise<Response<string>> {
        const response = await this.restClient.get(`${ModelServerPaths.UNDO}?modeluri=${modelUri}`);
        return response.mapBody(ResponseBody.asString);
    }

    async redo(modelUri: string): Promise<Response<string>> {
        const response = await this.restClient.get(`${ModelServerPaths.REDO}?modeluri=${modelUri}`);
        return response.mapBody(ResponseBody.asString);
    }

    async save(modelUri: string): Promise<Response<boolean>> {
        const response = await this.restClient.get(`${ModelServerPaths.SAVE}?modeluri=${modelUri}`);
        return response.mapBody(ResponseBody.isSuccess);
    }

    async saveAll(): Promise<Response<boolean>> {
        const response = await this.restClient.get(ModelServerPaths.SAVE_ALL);
        return response.mapBody(ResponseBody.isSuccess);
    }

    async update(modelUri: string, newModel: any): Promise<Response<string>> {
        const response = await this.restClient.patch(`${ModelServerPaths.MODEL_CRUD}?modeluri=${modelUri}`, RequestBody.fromData(newModel));
        return response.mapBody(ResponseBody.asString);
    }

    async configure(configuration: ServerConfiguration): Promise<Response<boolean>> {
        const workspaceRoot = configuration.workspaceRoot.replace('file://', '');
        const uiSchemaFolder = configuration.uiSchemaFolder?.replace('file://', '');
        const response = await this.restClient.put(ModelServerPaths.SERVER_CONFIGURE, RequestBody.from({ workspaceRoot, uiSchemaFolder }));
        return response.mapBody(ResponseBody.isSuccess);
    }

    async ping(): Promise<Response<boolean>> {
        const response = await this.restClient.get(ModelServerPaths.SERVER_PING);
        return response.mapBody(ResponseBody.isSuccess);
    }

    async edit(modelUri: string, command: ModelServerCommand): Promise<Response<boolean>> {
        const response = await this.restClient.patch(`${ModelServerPaths.COMMANDS}?modeluri=${modelUri}`, RequestBody.fromData(command));
        return response.mapBody(ResponseBody.isSuccess);
    }

    async getTypeSchema(modelUri: string): Promise<Response<string>> {
        const response = await this.restClient.get(`${ModelServerPaths.TYPE_SCHEMA}?modeluri=${modelUri}`);
        return response.mapBody(ResponseBody.asString);
    }

    async getUiSchema(schemaName: string): Promise<Response<string>> {
        const response = await this.restClient.get(`${ModelServerPaths.UI_SCHEMA}?schemaname=${schemaName}`);
        return response.mapBody(ResponseBody.asString);
    }

    subscribe(modelUri: string): void {
        const path = `${this.baseUrl}${ModelServerPaths.SUBSCRIPTION}?modeluri=${modelUri}`;
        this.doSubscribe(modelUri, path);
    }

    subscribeWithTimeout(modelUri: string, timeout: number): void {
        const path = `${this.baseUrl}${ModelServerPaths.SUBSCRIPTION}?modeluri=${modelUri}&timeout=${timeout}`;
        this.doSubscribe(modelUri, path);
    }

    protected doSubscribe(modelUri: string, path: string): void {
        const socket = new WebSocket(path.trim());
        socket.onopen = event => this.subscriptionClient.fireOpenEvent(event, modelUri);
        socket.onmessage = messageEvent => this.subscriptionClient.fireMessageEvent(messageEvent, modelUri);
        socket.onclose = closeEvent => {
            this.subscriptionClient.fireClosedEvent(closeEvent, modelUri);
            this.openSockets.delete(modelUri);
        };
        socket.onerror = errorEvent => this.subscriptionClient.fireErrorEvent(errorEvent, modelUri);
        this.openSockets.set(modelUri, socket);
    }

    protected isSocketOpen(modelUri: string): boolean {
        return this.openSockets.get(modelUri) !== undefined;
    }

    sendKeepAlive(modelUri: string): void {
        const openSocket = this.openSockets.get(modelUri);
        if (openSocket) {
            const msg: ModelServerMessage = { type: 'keepAlive', data: '' };
            openSocket.send(JSON.stringify(msg));
        }
    }

    unsubscribe(modelUri: string): void {
        const openSocket = this.openSockets.get(modelUri);
        if (openSocket) {
            openSocket.close();
            this.openSockets.delete(modelUri);
        }
    }

    setClient(subscriptionClient: ModelServerSubscriptionClient): void {
        this.subscriptionClient = subscriptionClient;
    }

    dispose(): void {
        Array.from(this.openSockets.values()).forEach(openSocket => openSocket.close());
    }

    getLaunchOptions(): Promise<LaunchOptions> {
        return Promise.resolve(
            this.options ? this.options : DEFAULT_LAUNCH_OPTIONS
        );
    }
}