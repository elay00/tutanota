import o from "ospec"
import { instance, matchers, object, when } from "testdouble"
import {
	createCreateSessionReturn,
	createGroupInfo,
	createGroupMembership,
	createSaltReturn,
	createUser,
	createUserExternalAuthInfo,
	GroupInfoTypeRef,
	User,
	UserTypeRef,
} from "../../../../../src/api/entities/sys/TypeRefs"
import { createAuthVerifier, encryptKey, generateKeyFromPassphrase, KeyLength, keyToBase64, sha256Hash } from "@tutao/tutanota-crypto"
import { LoginFacade, LoginListener, ResumeSessionErrorReason } from "../../../../../src/api/worker/facades/LoginFacade"
import { IServiceExecutor } from "../../../../../src/api/common/ServiceRequest"
import { EntityClient } from "../../../../../src/api/common/EntityClient"
import { RestClient } from "../../../../../src/api/worker/rest/RestClient"
import { WorkerImpl } from "../../../../../src/api/worker/WorkerImpl"
import { InstanceMapper } from "../../../../../src/api/worker/crypto/InstanceMapper"
import { CryptoFacade, encryptString } from "../../../../../src/api/worker/crypto/CryptoFacade"
import { CacheStorageLateInitializer } from "../../../../../src/api/worker/rest/CacheStorageProxy"
import { UserFacade } from "../../../../../src/api/worker/facades/UserFacade"
import { SaltService, SessionService } from "../../../../../src/api/entities/sys/Services"
import { Credentials } from "../../../../../src/misc/credentials/Credentials"
import { defer, DeferredObject, uint8ArrayToBase64 } from "@tutao/tutanota-utils"
import { AccountType } from "../../../../../src/api/common/TutanotaConstants"
import { AccessExpiredError, ConnectionError, NotAuthenticatedError } from "../../../../../src/api/common/error/RestError"
import { assertThrows, verify } from "@tutao/tutanota-test-utils"
import { SessionType } from "../../../../../src/api/common/SessionType"
import { HttpMethod } from "../../../../../src/api/common/EntityFunctions"
import { ConnectMode, EventBusClient } from "../../../../../src/api/worker/EventBusClient"
import { createTutanotaProperties, TutanotaPropertiesTypeRef } from "../../../../../src/api/entities/tutanota/TypeRefs"
import { BlobAccessTokenFacade } from "../../../../../src/api/worker/facades/BlobAccessTokenFacade.js"
import { EntropyFacade } from "../../../../../src/api/worker/facades/EntropyFacade.js"

const { anything } = matchers

const SALT = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])

function makeUser({ id, passphrase, salt }) {
	const userPassphraseKey = generateKeyFromPassphrase(passphrase, salt, KeyLength.b128)

	const groupKey = encryptKey(userPassphraseKey, [3229306880, 2716953871, 4072167920, 3901332676])

	return createUser({
		_id: id,
		verifier: sha256Hash(createAuthVerifier(userPassphraseKey)),
		userGroup: createGroupMembership({
			group: "groupId",
			symEncGKey: groupKey,
			groupInfo: ["groupInfoListId", "groupInfoElId"],
		}),
	})
}

o.spec("LoginFacadeTest", function () {
	let facade: LoginFacade
	let workerMock: WorkerImpl
	let serviceExecutor: IServiceExecutor
	let restClientMock: RestClient
	let entityClientMock: EntityClient
	let loginListener: LoginListener
	let instanceMapperMock: InstanceMapper
	let cryptoFacadeMock: CryptoFacade
	let cacheStorageInitializerMock: CacheStorageLateInitializer
	let eventBusClientMock: EventBusClient
	let usingOfflineStorage: boolean
	let userFacade: UserFacade
	let entropyFacade: EntropyFacade
	let blobAccessTokenFacade: BlobAccessTokenFacade

	const timeRangeDays = 42

	o.beforeEach(function () {
		workerMock = instance(WorkerImpl)
		serviceExecutor = object()
		when(serviceExecutor.get(SaltService, anything()), { ignoreExtraArgs: true }).thenResolve(createSaltReturn({ salt: SALT }))

		restClientMock = instance(RestClient)
		entityClientMock = instance(EntityClient)
		when(entityClientMock.loadRoot(TutanotaPropertiesTypeRef, anything())).thenResolve(createTutanotaProperties())

		loginListener = object<LoginListener>()
		instanceMapperMock = instance(InstanceMapper)
		cryptoFacadeMock = object<CryptoFacade>()
		usingOfflineStorage = false
		cacheStorageInitializerMock = object()
		when(
			cacheStorageInitializerMock.initialize({
				userId: anything(),
				databaseKey: anything(),
				timeRangeDays: anything(),
				forceNewDatabase: anything(),
				type: "offline",
			}),
		).thenDo(async () => {
			return {
				isPersistent: usingOfflineStorage,
				isNewOfflineDb: false,
			}
		})
		when(cacheStorageInitializerMock.initialize({ userId: anything() as Id, type: "ephemeral" })).thenResolve({
			isPersistent: false,
			isNewOfflineDb: false,
		})
		userFacade = object()
		entropyFacade = object()

		facade = new LoginFacade(
			workerMock,
			restClientMock,
			entityClientMock,
			loginListener,
			instanceMapperMock,
			cryptoFacadeMock,
			cacheStorageInitializerMock,
			serviceExecutor,
			userFacade,
			blobAccessTokenFacade,
			entropyFacade,
		)

		eventBusClientMock = instance(EventBusClient)

		facade.init(eventBusClientMock)
	})

	o.spec("Creating new sessions", function () {
		o.spec("initializing cache storage", function () {
			const dbKey = new Uint8Array([1, 2, 3, 4, 1, 2, 3, 4])
			const passphrase = "hunter2"
			const userId = "userId"

			o.beforeEach(function () {
				when(serviceExecutor.post(SessionService, anything()), { ignoreExtraArgs: true }).thenResolve(
					createCreateSessionReturn({ user: userId, accessToken: "accessToken", challenges: [] }),
				)
				when(entityClientMock.load(UserTypeRef, userId)).thenResolve(
					makeUser({
						id: userId,
						passphrase,
						salt: SALT,
					}),
				)
			})

			o("When a database key is provided and session is persistent it is passed to the offline storage initializer", async function () {
				await facade.createSession("born.slippy@tuta.io", passphrase, "client", SessionType.Persistent, dbKey)
				verify(cacheStorageInitializerMock.initialize({ type: "offline", databaseKey: dbKey, userId, timeRangeDays: null, forceNewDatabase: true }))
			})
			o("When no database key is provided and session is persistent, nothing is passed to the offline storage initializer", async function () {
				await facade.createSession("born.slippy@tuta.io", passphrase, "client", SessionType.Persistent, null)
				verify(cacheStorageInitializerMock.initialize({ type: "ephemeral", userId }))
			})
			o("When no database key is provided and session is Login, nothing is passed to the offline storage initialzier", async function () {
				await facade.createSession("born.slippy@tuta.io", passphrase, "client", SessionType.Login, null)
				verify(cacheStorageInitializerMock.initialize({ type: "ephemeral", userId }))
			})
		})
	})

	o.spec("Resuming existing sessions", function () {
		o.spec("initializing cache storage", function () {
			const dbKey = new Uint8Array([1, 2, 3, 4, 1, 2, 3, 4])
			const passphrase = "hunter2"
			const userId = "userId"
			const accessKey = [3229306880, 2716953871, 4072167920, 3901332677]
			const accessToken = "accessToken"

			let credentials: Credentials

			const user = makeUser({
				id: userId,
				passphrase,
				salt: SALT,
			})

			o.beforeEach(function () {
				credentials = {
					/**
					 * Identifier which we use for logging in.
					 * Email address used to log in for internal users, userId for external users.
					 * */
					login: "born.slippy@tuta.io",

					/** Session#accessKey encrypted password. Is set when session is persisted. */
					encryptedPassword: uint8ArrayToBase64(encryptString(accessKey, passphrase)), // We can't call encryptString in the top level of spec because `random` isn't initialized yet
					accessToken,
					userId,
					type: "internal",
				} as Credentials

				when(entityClientMock.load(UserTypeRef, userId)).thenResolve(user)

				// The call to /sys/session/...
				when(
					restClientMock.request(
						matchers.argThat((path) => typeof path === "string" && path.startsWith("/rest/sys/session/")),
						HttpMethod.GET,
						anything(),
					),
				).thenResolve(JSON.stringify({ user: userId, accessKey: keyToBase64(accessKey) }))
			})

			o("When resuming a session and there is a database key, it is passed to offline storage initialization", async function () {
				usingOfflineStorage = true
				await facade.resumeSession(credentials, null, dbKey, timeRangeDays)
				verify(cacheStorageInitializerMock.initialize({ type: "offline", databaseKey: dbKey, userId, timeRangeDays, forceNewDatabase: false }))
			})
			o("When resuming a session and there is no database key, nothing is passed to offline storage initialization", async function () {
				usingOfflineStorage = true
				await facade.resumeSession(credentials, null, null, timeRangeDays)
				verify(cacheStorageInitializerMock.initialize({ type: "ephemeral", userId }))
			})
			o("when resuming a session and the offline initialization has created a new database, we do synchronous login", async function () {
				usingOfflineStorage = true
				user.accountType = AccountType.PREMIUM
				when(
					cacheStorageInitializerMock.initialize({ type: "offline", databaseKey: dbKey, userId, timeRangeDays, forceNewDatabase: false }),
				).thenResolve({
					isPersistent: true,
					isNewOfflineDb: true,
				})

				await facade.resumeSession(credentials, null, dbKey, timeRangeDays)

				o(facade.asyncLoginState).deepEquals({ state: "idle" })("Synchronous login occured, so once resume returns we have already logged in")
			})
			o("when resuming a session and the offline initialization has an existing database, we do async login", async function () {
				usingOfflineStorage = true
				user.accountType = AccountType.PREMIUM

				when(
					cacheStorageInitializerMock.initialize({ type: "offline", databaseKey: dbKey, userId, timeRangeDays, forceNewDatabase: false }),
				).thenResolve({
					isPersistent: true,
					isNewOfflineDb: false,
				})

				await facade.resumeSession(credentials, null, dbKey, timeRangeDays)

				o(facade.asyncLoginState).deepEquals({ state: "running" })("Async login occurred so it is still running")
			})
			o("when resuming a session and a notauthenticatedError is thrown, the offline db is deleted", async function () {
				usingOfflineStorage = true
				user.accountType = AccountType.FREE
				when(
					restClientMock.request(
						matchers.argThat((path) => path.startsWith("/rest/sys/session/")),
						HttpMethod.GET,
						anything(),
					),
				).thenReject(new NotAuthenticatedError("not your cheese"))
				await assertThrows(NotAuthenticatedError, () => facade.resumeSession(credentials, SALT, dbKey, timeRangeDays))
				verify(cacheStorageInitializerMock.deInitialize())
			})
		})

		o.spec("account type combinations", function () {
			let credentials: Credentials
			const dbKey = new Uint8Array([1, 2, 3, 4, 1, 2, 3, 4])
			const passphrase = "hunter2"
			const userId = "userId"
			const accessKey = [3229306880, 2716953871, 4072167920, 3901332677]
			const accessToken = "accessToken"
			const user = makeUser({
				id: userId,
				passphrase,
				salt: SALT,
			})
			let calls: string[]
			let fullLoginDeferred: DeferredObject<void>

			o.beforeEach(function () {
				credentials = {
					/**
					 * Identifier which we use for logging in.
					 * Email address used to log in for internal users, userId for external users.
					 * */
					login: "born.slippy@tuta.io",

					/** Session#accessKey encrypted password. Is set when session is persisted. */
					encryptedPassword: uint8ArrayToBase64(encryptString(accessKey, passphrase)), // We can't call encryptString in the top level of spec because `random` isn't initialized yet
					accessToken,
					userId,
					type: "internal",
				} as Credentials

				when(entityClientMock.load(UserTypeRef, userId)).thenResolve(user)

				// // The call to /sys/session/...
				// when(restClientMock.request(anything(), HttpMethod.GET, anything()))
				// 	.thenResolve(JSON.stringify({user: userId, accessKey: keyToBase64(accessKey)}))

				calls = []
				// .thenReturn(sessionServiceDefer)
				when(userFacade.setUser(anything())).thenDo(() => {
					calls.push("setUser")
				})
				when(userFacade.isPartiallyLoggedIn()).thenDo(() => calls.includes("setUser"))

				fullLoginDeferred = defer()
				when(loginListener.onFullLoginSuccess(matchers.anything(), matchers.anything())).thenDo(() => fullLoginDeferred.resolve())
			})

			o("When using offline as a free user and with stable connection, login sync", async function () {
				usingOfflineStorage = true
				user.accountType = AccountType.FREE
				await testSuccessfulSyncLogin()
			})

			o("When using offline as a free user with unstable connection, no offline for free users", async function () {
				usingOfflineStorage = true
				user.accountType = AccountType.FREE
				when(restClientMock.request(anything(), HttpMethod.GET, anything())).thenDo(async () => {
					calls.push("sessionService")
					throw new ConnectionError("Oopsie 1")
				})

				const result = await facade.resumeSession(credentials, user.salt, dbKey, timeRangeDays).finally(() => {
					calls.push("return")
				})

				o(result).deepEquals({ type: "error", reason: ResumeSessionErrorReason.OfflineNotAvailableForFree })
				o(calls).deepEquals(["sessionService", "return"])
			})

			o("When using offline as premium user with stable connection, async login", async function () {
				usingOfflineStorage = true
				user.accountType = AccountType.PREMIUM
				when(restClientMock.request(anything(), HttpMethod.GET, anything())).thenDo(async () => {
					calls.push("sessionService")
					return JSON.stringify({ user: userId, accessKey: keyToBase64(accessKey) })
				})

				const deferred = defer()
				when(loginListener.onFullLoginSuccess(matchers.anything(), matchers.anything())).thenDo(() => deferred.resolve(null))

				const result = await facade.resumeSession(credentials, user.salt, dbKey, timeRangeDays)

				o(result.type).equals("success")

				await deferred.promise

				// we would love to prove that part of the login is done async but without injecting some asyncExecutor it's a bit tricky to do
				o(calls).deepEquals(["setUser", "sessionService"])

				// just wait for the async login to not bleed into other test cases or to not randomly fail
				await fullLoginDeferred.promise
			})

			o("When using offline as premium user with unstable connection, async login with later retry", async function () {
				usingOfflineStorage = true
				user.accountType = AccountType.PREMIUM
				const connectionError = new ConnectionError("Oopsie 2")
				when(restClientMock.request(anything(), HttpMethod.GET, anything())).thenDo(async () => {
					calls.push("sessionService")
					throw connectionError
				})

				const deferred = defer()
				when(loginListener.onPartialLoginSuccess()).thenDo(() => deferred.resolve(null))

				const result = await facade.resumeSession(credentials, user.salt, dbKey, timeRangeDays)

				await deferred.promise

				o(result.type).equals("success")
				o(calls).deepEquals(["setUser", "sessionService"])

				// Did not finish login
				verify(userFacade.unlockUserGroupKey(anything()), { times: 0 })
			})

			o("When not using offline as free user with connection, sync login", async function () {
				usingOfflineStorage = false
				user.accountType = AccountType.FREE
				await testSuccessfulSyncLogin()
			})

			o("When not using offline as free user with unstable connection, sync login with connection error", async function () {
				usingOfflineStorage = false
				user.accountType = AccountType.FREE
				await testConnectionFailingSyncLogin()
			})

			o("When not using offline as premium user with stable connection, sync login", async function () {
				usingOfflineStorage = false
				user.accountType = AccountType.PREMIUM
				await testSuccessfulSyncLogin()
			})
			o("When not using offline as premium with unstable connection, sync login with connection error", async function () {
				usingOfflineStorage = false
				user.accountType = AccountType.PREMIUM
				await testConnectionFailingSyncLogin()
			})

			async function testSuccessfulSyncLogin() {
				when(restClientMock.request(anything(), HttpMethod.GET, anything())).thenDo(async () => {
					calls.push("sessionService")
					return JSON.stringify({ user: userId, accessKey: keyToBase64(accessKey) })
				})

				await facade.resumeSession(credentials, user.salt, dbKey, timeRangeDays).finally(() => {
					calls.push("return")
				})
				o(calls).deepEquals(["sessionService", "setUser", "return"])
			}

			async function testConnectionFailingSyncLogin() {
				when(restClientMock.request(anything(), HttpMethod.GET, anything())).thenDo(async () => {
					calls.push("sessionService")
					throw new ConnectionError("Oopsie 3")
				})

				await assertThrows(ConnectionError, () => facade.resumeSession(credentials, user.salt, dbKey, timeRangeDays))
				o(calls).deepEquals(["sessionService"])
			}
		})

		o.spec("async login", function () {
			let credentials: Credentials
			const dbKey = new Uint8Array([1, 2, 3, 4, 1, 2, 3, 4])
			const passphrase = "hunter2"
			const userId = "userId"
			const accessKey = [3229306880, 2716953871, 4072167920, 3901332677]
			const accessToken = "accessToken"
			const user = makeUser({
				id: userId,
				passphrase,
				salt: SALT,
			})
			let calls: string[]
			let fullLoginDeferred: DeferredObject<void>

			o.beforeEach(function () {
				usingOfflineStorage = true
				user.accountType = AccountType.PREMIUM

				credentials = {
					/**
					 * Identifier which we use for logging in.
					 * Email address used to log in for internal users, userId for external users.
					 * */
					login: "born.slippy@tuta.io",

					/** Session#accessKey encrypted password. Is set when session is persisted. */
					encryptedPassword: uint8ArrayToBase64(encryptString(accessKey, passphrase)), // We can't call encryptString in the top level of spec because `random` isn't initialized yet
					accessToken,
					userId,
					type: "internal",
				} as Credentials

				when(entityClientMock.load(UserTypeRef, userId)).thenResolve(user)

				// // The call to /sys/session/...
				// when(restClientMock.request(anything(), HttpMethod.GET, anything()))
				// 	.thenResolve(JSON.stringify({user: userId, accessKey: keyToBase64(accessKey)}))

				calls = []
				// .thenReturn(sessionServiceDefer)
				when(userFacade.setUser(anything())).thenDo(() => {
					calls.push("setUser")
				})
				when(userFacade.isPartiallyLoggedIn()).thenDo(() => calls.includes("setUser"))

				fullLoginDeferred = defer()
				when(loginListener.onFullLoginSuccess(matchers.anything(), matchers.anything())).thenDo(() => fullLoginDeferred.resolve())
			})

			o("When successfully logged in, userFacade is initialised", async function () {
				const groupInfo = createGroupInfo()
				when(entityClientMock.load(GroupInfoTypeRef, user.userGroup.groupInfo)).thenResolve(groupInfo)
				when(restClientMock.request(matchers.contains("sys/session"), HttpMethod.GET, anything())).thenResolve(
					JSON.stringify({ user: userId, accessKey: keyToBase64(accessKey) }),
				)

				await facade.resumeSession(credentials, user.salt, dbKey, timeRangeDays)

				await fullLoginDeferred.promise

				verify(userFacade.setAccessToken("accessToken"))
				verify(userFacade.unlockUserGroupKey(matchers.anything()))
				verify(eventBusClientMock.connect(ConnectMode.Initial))
			})

			o("when retrying failed login, userFacade is initialized", async function () {
				const deferred = defer()
				when(loginListener.onLoginFailure(matchers.anything())).thenDo(() => deferred.resolve(null))

				const groupInfo = createGroupInfo()
				when(entityClientMock.load(GroupInfoTypeRef, user.userGroup.groupInfo)).thenResolve(groupInfo)
				const connectionError = new ConnectionError("test")
				when(userFacade.isFullyLoggedIn()).thenReturn(false)

				when(restClientMock.request(matchers.contains("sys/session"), HttpMethod.GET, anything()))
					// @ts-ignore
					// the type definitions for testdouble are lacking, but we can do this
					.thenReturn(Promise.reject(connectionError), Promise.resolve(JSON.stringify({ user: userId, accessKey: keyToBase64(accessKey) })))

				await facade.resumeSession(credentials, user.salt, dbKey, timeRangeDays)

				verify(userFacade.setAccessToken("accessToken"))
				verify(userFacade.unlockUserGroupKey(anything()), { times: 0 })
				verify(userFacade.unlockUserGroupKey(matchers.anything()), { times: 0 })
				verify(eventBusClientMock.connect(ConnectMode.Initial), { times: 0 })

				await deferred.promise

				await facade.retryAsyncLogin()

				await fullLoginDeferred.promise

				verify(userFacade.setAccessToken("accessToken"))
				verify(userFacade.unlockUserGroupKey(matchers.anything()))
				verify(eventBusClientMock.connect(ConnectMode.Initial))
			})
		})

		o.spec("external sessions", function () {
			const passphrase = "hunter2"
			const userId = "userId"
			const accessKey = [3229306880, 2716953871, 4072167920, 3901332677]
			const accessToken = "accessToken"
			let user: User

			let credentials: Credentials

			o.beforeEach(function () {
				credentials = {
					/**
					 * Identifier which we use for logging in.
					 * Email address used to log in for internal users, userId for external users.
					 * */
					login: userId,

					/** Session#accessKey encrypted password. Is set when session is persisted. */
					encryptedPassword: uint8ArrayToBase64(encryptString(accessKey, passphrase)), // We can't call encryptString in the top level of spec because `random` isn't initialized yet
					accessToken,
					userId,
					type: "internal",
				} as Credentials

				user = makeUser({
					id: userId,
					passphrase,
					salt: SALT,
				})
				user.externalAuthInfo = createUserExternalAuthInfo({
					latestSaltHash: sha256Hash(SALT),
				})

				when(entityClientMock.load(UserTypeRef, userId)).thenResolve(user)

				when(restClientMock.request(matchers.contains("sys/session"), HttpMethod.GET, anything())).thenResolve(
					JSON.stringify({ user: userId, accessKey: keyToBase64(accessKey) }),
				)
			})

			o("when the salt is not outdated, login works", async function () {
				const result = await facade.resumeSession(credentials, SALT, null, timeRangeDays)

				o(result.type).equals("success")
			})

			o("when the salt is outdated, AccessExpiredError is thrown", async function () {
				user.externalAuthInfo!.latestSaltHash = new Uint8Array([1, 2, 3])

				await assertThrows(AccessExpiredError, () => facade.resumeSession(credentials, SALT, null, timeRangeDays))
				verify(restClientMock.request(matchers.contains("sys/session"), HttpMethod.DELETE, anything()), { times: 0 })
			})

			o("when the password is outdated, NotAuthenticatedErorr is thrown", async function () {
				user.verifier = new Uint8Array([1, 2, 3])
				when(restClientMock.request(matchers.contains("sys/session"), HttpMethod.DELETE, anything())).thenResolve(null)

				await assertThrows(NotAuthenticatedError, () => facade.resumeSession(credentials, SALT, null, timeRangeDays))
				verify(restClientMock.request(matchers.contains("sys/session"), HttpMethod.DELETE, anything()))
			})
		})
	})
})
