import { defineInterface, requestType } from "@hediet/linkrpc";
import { Hub, hubRegisterServiceId } from "@hediet/linkrpc-hub/hub/server";
import { z } from "zod";

const serviceHealthInterface = defineInterface(
    {
        id: "vscode.serviceHealth",
        description: "Reports whether a service is available and ready to accept requests.",
    },
    {
        getStatus: requestType(
            z.object({}),
            z.object({ status: z.enum(["ready", "degraded"]) }),
            { description: "Get the current health status of this service." },
        ),
    },
);

const workspaceSearchInterface = defineInterface(
    {
        id: "vscode.workspaceSearch",
        description: "Searches workspace files and textual contents.",
    },
    {
        findFiles: requestType(
            z.object({
                include: z.string(),
                exclude: z.string().optional(),
                maxResults: z.number().int().positive().optional(),
            }),
            z.object({ uris: z.array(z.string()) }),
            { description: "Find file paths matching include and exclude glob patterns." },
        ),
        searchText: requestType(
            z.object({ query: z.string(), include: z.string().optional() }),
            z.object({ matches: z.array(z.object({ uri: z.string(), line: z.number().int() })) }),
            { description: "Search file contents for a textual query." },
        ),
    },
);

const symbolIndexInterface = defineInterface(
    {
        id: "vscode.symbolIndex",
        description: "Searches programming-language symbols and their relationships.",
    },
    {
        findSymbols: requestType(
            z.object({ query: z.string() }),
            z.object({ locations: z.array(z.string()) }),
            { description: "Find symbol definitions by a textual symbol query." },
        ),
        findReferences: requestType(
            z.object({ uri: z.string(), line: z.number().int(), character: z.number().int() }),
            z.object({ locations: z.array(z.string()) }),
            { description: "Find all references to the symbol at an exact source position." },
        ),
    },
);

const pullRequestsInterface = defineInterface(
    {
        id: "vscode.pullRequests",
        description: "Reads and updates pull-request review state.",
    },
    {
        createReviewThread: requestType(
            z.object({
                pullRequest: z.number().int().positive(),
                file: z.string(),
                line: z.number().int().positive(),
                body: z.string(),
            }),
            z.object({ threadId: z.string() }),
            { description: "Create an inline review thread at a file and line in a pull request." },
        ),
        addConversationComment: requestType(
            z.object({ pullRequest: z.number().int().positive(), body: z.string() }),
            z.object({ commentId: z.string() }),
            { description: "Add a general pull-request conversation comment without a code location." },
        ),
        submitReview: requestType(
            z.object({
                pullRequest: z.number().int().positive(),
                verdict: z.enum(["approve", "requestChanges", "comment"]),
            }),
            z.object({ reviewId: z.string() }),
            { description: "Submit an overall review verdict for a pull request." },
        ),
    },
);

const issuesInterface = defineInterface(
    {
        id: "vscode.issues",
        description: "Creates issues and participates in issue discussions.",
    },
    {
        createIssue: requestType(
            z.object({ title: z.string(), body: z.string() }),
            z.object({ issueNumber: z.number().int().positive() }),
            { description: "Create a repository issue." },
        ),
        addIssueComment: requestType(
            z.object({ issueNumber: z.number().int().positive(), body: z.string() }),
            z.object({ commentId: z.string() }),
            { description: "Add a comment to an existing issue." },
        ),
    },
);

const deploymentsInterface = defineInterface(
    {
        id: "vscode.deployments",
        description: "Starts deployments and inspects deployment execution.",
    },
    {
        startDeployment: requestType(
            z.object({ environment: z.string(), revision: z.string() }),
            z.object({ deploymentId: z.string() }),
            { description: "Start a new deployment of a revision to an environment." },
        ),
        getDeploymentStatus: requestType(
            z.object({ deploymentId: z.string() }),
            z.object({ status: z.string() }),
            { description: "Get the current status of a deployment." },
        ),
        getDeploymentLogs: requestType(
            z.object({ deploymentId: z.string(), tail: z.number().int().positive().optional() }),
            z.object({ lines: z.array(z.string()) }),
            { description: "Read execution logs for an existing deployment without changing it." },
        ),
    },
);

const environmentsInterface = defineInterface(
    {
        id: "vscode.environments",
        description: "Resolves deployment environments and their configuration.",
    },
    {
        resolveEnvironment: requestType(
            z.object({ name: z.string() }),
            z.object({ id: z.string(), region: z.string() }),
            { description: "Resolve an environment name to its deployment configuration." },
        ),
        listEnvironments: requestType(
            z.object({}),
            z.object({ names: z.array(z.string()) }),
            { description: "List the available deployment environments." },
        ),
    },
);

const incidentsInterface = defineInterface(
    {
        id: "vscode.incidents",
        description: "Creates incidents and maintains their response timelines.",
    },
    {
        createIncident: requestType(
            z.object({ title: z.string(), severity: z.enum(["sev1", "sev2", "sev3"]) }),
            z.object({ incidentId: z.string() }),
            { description: "Create a new operational incident." },
        ),
        appendTimelineEntry: requestType(
            z.object({ incidentId: z.string(), message: z.string() }),
            z.object({ entryId: z.string() }),
            { description: "Append an event to an existing incident timeline." },
        ),
    },
);

const onCallInterface = defineInterface(
    {
        id: "vscode.onCall",
        description: "Looks up current on-call ownership and schedules.",
    },
    {
        findResponder: requestType(
            z.object({ service: z.string(), at: z.string().optional() }),
            z.object({ user: z.string(), escalationPolicy: z.string() }),
            { description: "Find the person currently responsible for responding to a service alert." },
        ),
        listSchedule: requestType(
            z.object({ service: z.string(), from: z.string(), to: z.string() }),
            z.object({ shifts: z.array(z.object({ user: z.string(), startsAt: z.string() })) }),
            { description: "List scheduled on-call shifts over a time range." },
        ),
    },
);

const dataCatalogInterface = defineInterface(
    {
        id: "vscode.dataCatalog",
        description: "Searches governed datasets and their ownership metadata.",
    },
    {
        findDatasetOwner: requestType(
            z.object({ dataset: z.string() }),
            z.object({ team: z.string(), contact: z.string() }),
            { description: "Find the team and contact responsible for a dataset." },
        ),
        searchDatasets: requestType(
            z.object({ query: z.string() }),
            z.object({ datasets: z.array(z.string()) }),
            { description: "Search dataset names and descriptions." },
        ),
    },
);

const warehouseInterface = defineInterface(
    {
        id: "vscode.warehouse",
        description: "Plans and executes analytical warehouse queries.",
    },
    {
        runQuery: requestType(
            z.object({ sql: z.string() }),
            z.object({ rows: z.array(z.record(z.string(), z.unknown())) }),
            { description: "Execute a SQL query against the analytical warehouse." },
        ),
        explainQuery: requestType(
            z.object({ sql: z.string() }),
            z.object({ plan: z.string() }),
            { description: "Explain a SQL query plan without executing the query." },
        ),
    },
);

const messagesInterface = defineInterface(
    {
        id: "vscode.messages",
        description: "Sends messages and searches historical conversations.",
    },
    {
        sendMessage: requestType(
            z.object({ channel: z.string(), body: z.string() }),
            z.object({ messageId: z.string() }),
            { description: "Send a new message to a channel." },
        ),
        searchMessages: requestType(
            z.object({ query: z.string(), channel: z.string().optional() }),
            z.object({ messages: z.array(z.object({ channel: z.string(), body: z.string() })) }),
            { description: "Search existing message history without sending a message." },
        ),
    },
);

const channelsInterface = defineInterface(
    {
        id: "vscode.channels",
        description: "Lists and administers collaboration channels.",
    },
    {
        listChannels: requestType(
            z.object({ includeArchived: z.boolean().optional() }),
            z.object({ channels: z.array(z.string()) }),
            { description: "List collaboration channels." },
        ),
        archiveChannel: requestType(
            z.object({ channel: z.string() }),
            z.object({ archived: z.boolean() }),
            { description: "Archive a collaboration channel." },
        ),
    },
);

const accountsInterface = defineInterface(
    {
        id: "vscode.accounts",
        description: "Looks up and administers organization accounts.",
    },
    {
        findAccount: requestType(
            z.object({ email: z.string() }),
            z.object({ accountId: z.string(), status: z.string() }),
            { description: "Find an organization account by email address." },
        ),
        suspendAccount: requestType(
            z.object({ accountId: z.string(), reason: z.string() }),
            z.object({ suspended: z.boolean() }),
            { description: "Suspend an organization account." },
        ),
    },
);

const sessionsInterface = defineInterface(
    {
        id: "vscode.sessions",
        description: "Lists and revokes authenticated account sessions.",
    },
    {
        listSessions: requestType(
            z.object({ accountId: z.string() }),
            z.object({ sessionIds: z.array(z.string()) }),
            { description: "List active login sessions for an account." },
        ),
        revokeSession: requestType(
            z.object({ sessionId: z.string() }),
            z.object({ revoked: z.boolean() }),
            { description: "Revoke one authenticated session." },
        ),
    },
);

export interface ExploreScenario {
    readonly id: string;
    readonly task: string;
    readonly expectedOperation: string;
}

export const linkRpcExploreScenarios: readonly ExploreScenario[] = [
    {
        id: "workspace-symbol-references",
        task: "find all references to the symbol at a known source position",
        expectedOperation: "workbench::vscode.symbolIndex::findReferences",
    },
    {
        id: "pull-request-inline-comment",
        task: "add an inline review comment to a specific file and line of a pull request",
        expectedOperation: "source-control::vscode.pullRequests::createReviewThread",
    },
    {
        id: "deployment-log-inspection",
        task: "read the latest log lines from an existing deployment without starting or modifying it",
        expectedOperation: "delivery::vscode.deployments::getDeploymentLogs",
    },
    {
        id: "current-on-call-responder",
        task: "identify who is currently responsible for responding to alerts for a service",
        expectedOperation: "operations::vscode.onCall::findResponder",
    },
    {
        id: "dataset-ownership",
        task: "find the team and contact responsible for a named governed dataset",
        expectedOperation: "data-platform::vscode.dataCatalog::findDatasetOwner",
    },
    {
        id: "historical-message-search",
        task: "search existing channel history for a phrase without sending a new message",
        expectedOperation: "collaboration::vscode.messages::searchMessages",
    },
];

export function getLinkRpcExploreScenario(id: string): ExploreScenario {
    const scenario = linkRpcExploreScenarios.find((candidate) => candidate.id === id);
    if (!scenario) {
        throw new Error(`Unknown scenario ${JSON.stringify(id)}`);
    }
    return scenario;
}

export function registerLinkRpcExploreCatalog(hub: Hub): () => void {
    const workbench = hubRegisterServiceId(hub, "workbench");
    workbench.connection.register(
        serviceHealthInterface,
        { getStatus: () => ({ status: "ready" as const }) },
        { serviceId: "workbench", serviceDescription: "Workspace search and language intelligence." },
    );
    workbench.connection.register(
        workspaceSearchInterface,
        { findFiles: () => ({ uris: [] }), searchText: () => ({ matches: [] }) },
        { serviceId: "workbench" },
    );
    workbench.connection.register(
        symbolIndexInterface,
        { findSymbols: () => ({ locations: [] }), findReferences: () => ({ locations: [] }) },
        { serviceId: "workbench" },
    );

    const sourceControl = hubRegisterServiceId(hub, "source-control");
    sourceControl.connection.register(
        serviceHealthInterface,
        { getStatus: () => ({ status: "ready" as const }) },
        { serviceId: "source-control", serviceDescription: "Pull requests, reviews, and issues." },
    );
    sourceControl.connection.register(
        pullRequestsInterface,
        {
            createReviewThread: () => ({ threadId: "thread-1" }),
            addConversationComment: () => ({ commentId: "comment-1" }),
            submitReview: () => ({ reviewId: "review-1" }),
        },
        { serviceId: "source-control" },
    );
    sourceControl.connection.register(
        issuesInterface,
        {
            createIssue: () => ({ issueNumber: 1 }),
            addIssueComment: () => ({ commentId: "issue-comment-1" }),
        },
        { serviceId: "source-control" },
    );

    const delivery = hubRegisterServiceId(hub, "delivery");
    delivery.connection.register(
        serviceHealthInterface,
        { getStatus: () => ({ status: "ready" as const }) },
        { serviceId: "delivery", serviceDescription: "Deployment execution and environments." },
    );
    delivery.connection.register(
        deploymentsInterface,
        {
            startDeployment: () => ({ deploymentId: "deployment-1" }),
            getDeploymentStatus: () => ({ status: "running" }),
            getDeploymentLogs: () => ({ lines: [] }),
        },
        { serviceId: "delivery" },
    );
    delivery.connection.register(
        environmentsInterface,
        {
            resolveEnvironment: () => ({ id: "environment-1", region: "west-europe" }),
            listEnvironments: () => ({ names: ["production"] }),
        },
        { serviceId: "delivery" },
    );

    const operations = hubRegisterServiceId(hub, "operations");
    operations.connection.register(
        serviceHealthInterface,
        { getStatus: () => ({ status: "ready" as const }) },
        { serviceId: "operations", serviceDescription: "Incident response and on-call ownership." },
    );
    operations.connection.register(
        incidentsInterface,
        {
            createIncident: () => ({ incidentId: "incident-1" }),
            appendTimelineEntry: () => ({ entryId: "entry-1" }),
        },
        { serviceId: "operations" },
    );
    operations.connection.register(
        onCallInterface,
        {
            findResponder: () => ({ user: "operator", escalationPolicy: "primary" }),
            listSchedule: () => ({ shifts: [] }),
        },
        { serviceId: "operations" },
    );

    const dataPlatform = hubRegisterServiceId(hub, "data-platform");
    dataPlatform.connection.register(
        serviceHealthInterface,
        { getStatus: () => ({ status: "ready" as const }) },
        { serviceId: "data-platform", serviceDescription: "Governed datasets and analytical queries." },
    );
    dataPlatform.connection.register(
        dataCatalogInterface,
        {
            findDatasetOwner: () => ({ team: "analytics", contact: "analytics@example.test" }),
            searchDatasets: () => ({ datasets: [] }),
        },
        { serviceId: "data-platform" },
    );
    dataPlatform.connection.register(
        warehouseInterface,
        { runQuery: () => ({ rows: [] }), explainQuery: () => ({ plan: "scan" }) },
        { serviceId: "data-platform" },
    );

    const collaboration = hubRegisterServiceId(hub, "collaboration");
    collaboration.connection.register(
        serviceHealthInterface,
        { getStatus: () => ({ status: "ready" as const }) },
        { serviceId: "collaboration", serviceDescription: "Messages and channels." },
    );
    collaboration.connection.register(
        messagesInterface,
        {
            sendMessage: () => ({ messageId: "message-1" }),
            searchMessages: () => ({ messages: [] }),
        },
        { serviceId: "collaboration" },
    );
    collaboration.connection.register(
        channelsInterface,
        { listChannels: () => ({ channels: [] }), archiveChannel: () => ({ archived: true }) },
        { serviceId: "collaboration" },
    );

    const identity = hubRegisterServiceId(hub, "identity");
    identity.connection.register(
        serviceHealthInterface,
        { getStatus: () => ({ status: "ready" as const }) },
        { serviceId: "identity", serviceDescription: "Organization accounts and login sessions." },
    );
    identity.connection.register(
        accountsInterface,
        {
            findAccount: () => ({ accountId: "account-1", status: "active" }),
            suspendAccount: () => ({ suspended: true }),
        },
        { serviceId: "identity" },
    );
    identity.connection.register(
        sessionsInterface,
        { listSessions: () => ({ sessionIds: [] }), revokeSession: () => ({ revoked: true }) },
        { serviceId: "identity" },
    );

    const services = [
        workbench,
        sourceControl,
        delivery,
        operations,
        dataPlatform,
        collaboration,
        identity,
    ];
    return () => {
        for (const service of services.reverse()) {
            service.dispose();
        }
    };
}
