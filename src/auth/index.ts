/**
 * Authentication Module
 *
 * This module handles OAuth 2.0 authentication with Microsoft for OneDrive access.
 * It implements the Device Code Flow manually (rather than using MSAL) for
 * cross-platform compatibility with iOS/Android WebViews.
 *
 * ## Module Structure
 *
 * - **deviceCodeFlow.ts** - OAuth 2.0 Device Code Flow implementation
 *   Handles the core OAuth protocol: device code request, polling, token refresh
 *
 * - **authProvider.ts** - Microsoft Graph SDK integration
 *   Implements AuthenticationProvider interface for automatic token injection
 *
 * - **tokenStorage.ts** - Secure token persistence
 *   Uses Obsidian's SecretStorage API with migration from legacy data.json storage
 *
 * ## Usage
 *
 * ```typescript
 * import { DeviceCodeFlowClient, OneDriveAuthProvider, TokenStorage } from './auth';
 *
 * const tokenStorage = new TokenStorage();
 * const deviceCodeClient = new DeviceCodeFlowClient(clientId, accessMode);
 * const authProvider = new OneDriveAuthProvider(tokenStorage, deviceCodeClient);
 *
 * // Use authProvider with Microsoft Graph Client
 * const graphClient = Client.initWithMiddleware({ authProvider });
 * ```
 *
 * ## Why not MSAL?
 *
 * See deviceCodeFlow.ts header comment for detailed explanation.
 * Summary: MSAL requires Node.js APIs not available on mobile platforms.
 */

export { DeviceCodeFlowClient } from './deviceCodeFlow';
export { OneDriveAuthProvider } from './authProvider';
export { TokenStorage } from './tokenStorage';
