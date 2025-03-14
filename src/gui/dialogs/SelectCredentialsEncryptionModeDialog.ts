import { CredentialEncryptionMode } from "../../misc/credentials/CredentialEncryptionMode"
import { Dialog, DialogType } from "../base/Dialog"
import type { CredentialsProvider } from "../../misc/credentials/CredentialsProvider.js"
import m, { Children, Component, Vnode } from "mithril"
import { lang } from "../../misc/LanguageViewModel"
import { theme } from "../theme"
import { DialogHeaderBar } from "../base/DialogHeaderBar"
import type { RadioSelectorOption } from "../base/RadioSelector"
import { RadioSelector } from "../base/RadioSelector"
import { ButtonType } from "../base/Button.js"
import { CredentialAuthenticationError } from "../../api/common/error/CredentialAuthenticationError"
import { KeyPermanentlyInvalidatedError } from "../../api/common/error/KeyPermanentlyInvalidatedError"
import { liveDataAttrs } from "../AriaUtils"
import type { DeferredObject } from "@tutao/tutanota-utils"
import { defer } from "@tutao/tutanota-utils"
import { windowFacade } from "../../misc/WindowFacade"

const DEFAULT_MODE = CredentialEncryptionMode.DEVICE_LOCK

export async function showCredentialsEncryptionModeDialog(credentialsProvider: CredentialsProvider) {
	await CredentialEncryptionMethodDialog.showAndWaitForSelection(credentialsProvider)
}

class CredentialEncryptionMethodDialog {
	readonly _credentialsProvider: CredentialsProvider
	_error: string | null
	readonly _finished: DeferredObject<void>
	readonly _dialog: Dialog
	readonly _supportedModes: ReadonlyArray<CredentialEncryptionMode>
	readonly _previousSelection: CredentialEncryptionMode | null

	/** @private */
	constructor(
		credentialsProvider: CredentialsProvider,
		supportedModes: ReadonlyArray<CredentialEncryptionMode>,
		previousSelection: CredentialEncryptionMode | null,
	) {
		this._credentialsProvider = credentialsProvider
		this._supportedModes = supportedModes
		this._previousSelection = previousSelection
		this._error = null
		this._finished = defer()
		this._dialog = new Dialog(DialogType.EditMedium, {
			view: () => {
				// We need custom dialog because:
				// - We don't need large dialog
				// - We want our selector button in the body and not in the header and it must stick to the bottom of the dialog
				//   (large dialog scrolls its contents and that's *not* what we want for that button).
				return m("", [
					// Only allow skipping if it's first time user selects mode (not from settings)
					previousSelection == null
						? m(
								".dialog-header.plr-l",
								m(DialogHeaderBar, {
									left: () => [
										{
											label: "skip_action",
											click: () => this._onModeSelected(DEFAULT_MODE),
											type: ButtonType.Secondary,
										} as const,
									],
								}),
						  )
						: null,
					m(
						".rel",
						m(SelectCredentialsEncryptionModeView, {
							error: this._error,
							onModeSelected: (mode) => this._onModeSelected(mode),
							supportedModes: this._supportedModes,
							previousSelection: this._previousSelection ?? DEFAULT_MODE,
						}),
					),
				])
			},
		})
		this._dialog.setCloseHandler(() => {
			this._finished.resolve()
			this._dialog.close()
		})
	}

	static async showAndWaitForSelection(credentialsProvider: CredentialsProvider) {
		const supportedModes = await credentialsProvider.getSupportedEncryptionModes()
		const previousSelection = credentialsProvider.getCredentialsEncryptionMode()
		const credentialsDialog = new CredentialEncryptionMethodDialog(credentialsProvider, supportedModes, previousSelection)

		credentialsDialog._dialog.show()

		await credentialsDialog._finished.promise
	}

	async _onModeSelected(mode: CredentialEncryptionMode) {
		try {
			await this._credentialsProvider.setCredentialsEncryptionMode(mode)

			this._dialog.close()

			this._finished.resolve()
		} catch (e) {
			if (e instanceof CredentialAuthenticationError) {
				this._error = e.message
				m.redraw()
			} else if (e instanceof KeyPermanentlyInvalidatedError) {
				await this._credentialsProvider.clearCredentials(e)

				this._dialog.close()

				await Dialog.message("credentialsKeyInvalidated_msg")
				windowFacade.reload({})
			} else {
				throw e
			}
		}
	}
}

type SelectCredentialEncryptionModeDialogAttrs = {
	previousSelection: CredentialEncryptionMode
	onModeSelected: (arg0: CredentialEncryptionMode) => unknown
	supportedModes: ReadonlyArray<CredentialEncryptionMode>
	error: string | null
}

class SelectCredentialsEncryptionModeView implements Component<SelectCredentialEncryptionModeDialogAttrs> {
	_currentMode: CredentialEncryptionMode

	constructor({ attrs }: Vnode<SelectCredentialEncryptionModeDialogAttrs>) {
		this._currentMode = attrs.previousSelection
	}

	view({ attrs }: Vnode<SelectCredentialEncryptionModeDialogAttrs>): Children {
		const options = this._getSupportedOptions(attrs)

		return [
			m(
				".flex.col.pt-m.scroll.plr-l",
				{
					style: {
						position: "relative",
						height: "100%",
						paddingBottom: "64px", // Padding to not overlap the button below
					},
				},
				[
					attrs.error ? m(".small.center.statusTextColor.pb-s" + liveDataAttrs(), attrs.error) : null,
					m("", lang.get("credentialsEncryptionModeSelection_msg")),
					m(
						".mt",
						m(RadioSelector, {
							options,
							selectedOption: this._currentMode,
							onOptionSelected: (mode: CredentialEncryptionMode) => {
								this._currentMode = mode
							},
						}),
					),
				],
			),
			this._renderSelectButton(() => attrs.onModeSelected(this._currentMode)),
		]
	}

	_getSupportedOptions(attrs: SelectCredentialEncryptionModeDialogAttrs): Array<RadioSelectorOption<CredentialEncryptionMode>> {
		const options = [
			{
				name: "credentialsEncryptionModeDeviceLock_label",
				value: CredentialEncryptionMode.DEVICE_LOCK,
				helpText: "credentialsEncryptionModeDeviceLockHelp_msg",
			},
			{
				name: "credentialsEncryptionModeDeviceCredentials_label",
				value: CredentialEncryptionMode.SYSTEM_PASSWORD,
				helpText: "credentialsEncryptionModeDeviceCredentialsHelp_msg",
			},
			{
				name: "credentialsEncryptionModeBiometrics_label",
				value: CredentialEncryptionMode.BIOMETRICS,
				helpText: "credentialsEncryptionModeBiometricsHelp_msg",
			},
		] as const
		return options.filter((option) => attrs.supportedModes.includes(option.value))
	}

	_renderSelectButton(onclick: () => unknown) {
		return m(
			"button.full-width.center.pb-s.pt-s.b.flex.items-center.justify-center",
			{
				style: {
					backgroundColor: theme.content_accent,
					color: "white",
					position: "absolute",
					bottom: "0",
					left: "0",
					right: "0",
					height: "60px",
					textTransform: "uppercase",
				},
				onclick,
			},
			lang.get("ok_action"),
		)
	}
}
