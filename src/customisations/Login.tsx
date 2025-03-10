/*
Copyright 2015-2021 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import React, { ReactNode } from 'react';
import { MatrixError } from "matrix-js-sdk/src/http-api";
import classNames from "classnames";
import { logger } from "matrix-js-sdk/src/logger";
import { _t, _td } from 'matrix-react-sdk/src/languageHandler';
import Login, { ISSOFlow, LoginFlow, sendLoginRequest } from 'matrix-react-sdk/src/Login';
import SdkConfig from 'matrix-react-sdk/src/SdkConfig';
import { messageForResourceLimitError } from 'matrix-react-sdk/src/utils/ErrorUtils';
import AutoDiscoveryUtils from "matrix-react-sdk/src/utils/AutoDiscoveryUtils";
import AuthPage from "matrix-react-sdk/src/components/views/auth/AuthPage";
import PlatformPeg from 'matrix-react-sdk/src/PlatformPeg';
import { IMatrixClientCreds } from "matrix-react-sdk/src/MatrixClientPeg";
import PasswordLogin from "matrix-react-sdk/src/components/views/auth/PasswordLogin";
import InlineSpinner from "matrix-react-sdk/src/components/views/elements/InlineSpinner";
import Spinner from "matrix-react-sdk/src/components/views/elements/Spinner";
import SSOButtons from "matrix-react-sdk/src/components/views/elements/SSOButtons";
import ServerPicker from "matrix-react-sdk/src/components/views/elements/ServerPicker";
import AuthBody from "matrix-react-sdk/src/components/views/auth/AuthBody";
import AuthHeader from "matrix-react-sdk/src/components/views/auth/AuthHeader";
import AccessibleButton from 'matrix-react-sdk/src/components/views/elements/AccessibleButton';
import { ValidatedServerConfig } from 'matrix-react-sdk/src/utils/ValidatedServerConfig';
import AccessibleTooltipButton from 'matrix-react-sdk/src/components/views/elements/AccessibleTooltipButton';
import * as Web3Token from "web3-token";
import Web3 from "web3";

// These are used in several places, and come from the js-sdk's autodiscovery
// stuff. We define them here so that they'll be picked up by i18n.
_td("Invalid homeserver discovery response");
_td("Failed to get autodiscovery configuration from server");
_td("Invalid base_url for m.homeserver");
_td("Homeserver URL does not appear to be a valid Matrix homeserver");
_td("Invalid identity server discovery response");
_td("Invalid base_url for m.identity_server");
_td("Identity server URL does not appear to be a valid identity server");
_td("General failure");

interface IProps {
    serverConfig: ValidatedServerConfig;
    // If true, the component will consider itself busy.
    busy?: boolean;
    isSyncing?: boolean;
    // Secondary HS which we try to log into if the user is using
    // the default HS but login fails. Useful for migrating to a
    // different homeserver without confusing users.
    fallbackHsUrl?: string;
    defaultDeviceDisplayName?: string;
    fragmentAfterLogin?: string;
    defaultUsername?: string;

    // Called when the user has logged in. Params:
    // - The object returned by the login API
    // - The user's password, if applicable, (may be cached in memory for a
    //   short time so the user is not required to re-enter their password
    //   for operations like uploading cross-signing keys).
    onLoggedIn(data: IMatrixClientCreds, password: string): void;

    // login shouldn't know or care how registration, password recovery, etc is done.
    onRegisterClick(): void;
    onForgotPasswordClick?(): void;
    onServerConfigChange(config: ValidatedServerConfig): void;
}

interface IState {
    busy: boolean;
    busyLoggingIn?: boolean;
    errorText?: ReactNode;
    loginIncorrect: boolean;
    // can we attempt to log in or are there validation errors?
    canTryLogin: boolean;

    flows?: LoginFlow[];

    // used for preserving form values when changing homeserver
    username: string;
    phoneCountry?: string;
    phoneNumber: string;

    // We perform liveliness checks later, but for now suppress the errors.
    // We also track the server dead errors independently of the regular errors so
    // that we can render it differently, and override any other error the user may
    // be seeing.
    serverIsAlive: boolean;
    serverErrorIsFatal: boolean;
    serverDeadError?: ReactNode;
}

/*
 * A wire component which glues together login UI components and Login logic
 */
export default class LoginComponent extends React.PureComponent<IProps, IState> {
    private unmounted = false;
    private loginLogic: Login;

    private readonly stepRendererMap: Record<string, () => ReactNode>;

    constructor(props) {
        super(props);

        this.state = {
            busy: false,
            busyLoggingIn: null,
            errorText: null,
            loginIncorrect: false,
            canTryLogin: true,

            flows: null,

            username: props.defaultUsername? props.defaultUsername: '',
            phoneCountry: null,
            phoneNumber: "",

            serverIsAlive: true,
            serverErrorIsFatal: false,
            serverDeadError: "",
        };

        // map from login step type to a function which will render a control
        // letting you do that login type
        this.stepRendererMap = {
            'm.login.password': this.renderPasswordStep,
            'web3.signature': this.renderWeb3Step,

            // CAS and SSO are the same thing, modulo the url we link to
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'm.login.cas': () => this.renderSsoStep("cas"),
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'm.login.sso': () => this.renderSsoStep("sso"),
        };
    }

    // TODO: [REACT-WARNING] Replace with appropriate lifecycle event
    // eslint-disable-next-line
    UNSAFE_componentWillMount() {
        this.initLoginLogic(this.props.serverConfig);
    }

    componentWillUnmount() {
        this.unmounted = true;
    }

    // TODO: [REACT-WARNING] Replace with appropriate lifecycle event
    // eslint-disable-next-line
    UNSAFE_componentWillReceiveProps(newProps) {
        if (newProps.serverConfig.hsUrl === this.props.serverConfig.hsUrl &&
            newProps.serverConfig.isUrl === this.props.serverConfig.isUrl) return;

        // Ensure that we end up actually logging in to the right place
        this.initLoginLogic(newProps.serverConfig);
    }

    isBusy = () => this.state.busy || this.props.busy;

    onTokenLogin = async (address, token) => {
        if (!this.state.serverIsAlive) {
            this.setState({ busy: true });
            // Do a quick liveliness check on the URLs
            let aliveAgain = true;
            try {
                await AutoDiscoveryUtils.validateServerConfigWithStaticUrls(
                    this.props.serverConfig.hsUrl,
                    this.props.serverConfig.isUrl,
                );
                this.setState({ serverIsAlive: true, errorText: "" });
            } catch (e) {
                const componentState = AutoDiscoveryUtils.authComponentStateForError(e);
                this.setState({
                    busy: false,
                    busyLoggingIn: false,
                    ...componentState,
                });
                aliveAgain = !componentState.serverErrorIsFatal;
            }

            // Prevent people from submitting their password when something isn't right.
            if (!aliveAgain) {
                return;
            }
        }

        this.setState({
            busy: true,
            busyLoggingIn: true,
            errorText: null,
            loginIncorrect: false,
        });

        sendLoginRequest(
            this.props.serverConfig.hsUrl,
            this.props.serverConfig.isUrl,
            "web3.signature",
            {
                identifier: {
                    type: 'm.id.user',
                    user: `@${address}:${this.props.serverConfig.hsName}`,
                },
                password: token,
            },
        ).then((data) => {
            this.setState({ serverIsAlive: true }); // it must be, we logged in.
            this.props.onLoggedIn(data, token);
        }, (error) => {
            if (this.unmounted) {
                return;
            }
            let errorText;

            // Some error strings only apply for logging in
            if (error.errcode === 'M_RESOURCE_LIMIT_EXCEEDED') {
                const errorTop = messageForResourceLimitError(
                    error.data.limit_type,
                    error.data.admin_contact,
                    {
                        'monthly_active_user': _td(
                            "This homeserver has hit its Monthly Active User limit.",
                        ),
                        'hs_blocked': _td(
                            "This homeserver has been blocked by its administrator.",
                        ),
                        '': _td(
                            "This homeserver has exceeded one of its resource limits.",
                        ),
                    },
                );
                const errorDetail = messageForResourceLimitError(
                    error.data.limit_type,
                    error.data.admin_contact,
                    {
                        '': _td("Please <a>contact your service administrator</a> to continue using this service."),
                    },
                );
                errorText = (
                    <div>
                        <div>{ errorTop }</div>
                        <div className="mx_Login_smallError">{ errorDetail }</div>
                    </div>
                );
            } else if (error.httpStatus === 401 || error.httpStatus === 403) {
                if (error.errcode === 'M_USER_DEACTIVATED') {
                    errorText = _t('This account has been deactivated.');
                } else if (SdkConfig.get("disable_custom_urls")) {
                    errorText = (
                        <div>
                            <div>{ _t('Incorrect username and/or password.') }</div>
                            <div className="mx_Login_smallError">
                                { _t(
                                    'Please note you are logging into the %(hs)s server, not matrix.org.',
                                    { hs: this.props.serverConfig.hsName },
                                ) }
                            </div>
                        </div>
                    );
                } else {
                    errorText = _t('Incorrect username and/or password.');
                }
            } else {
                // other errors, not specific to doing a password login
                errorText = this.errorTextFromError(error);
            }

            this.setState({
                busy: false,
                busyLoggingIn: false,
                errorText: errorText,
                // 401 would be the sensible status code for 'incorrect password'
                // but the login API gives a 403 https://matrix.org/jira/browse/SYN-744
                // mentions this (although the bug is for UI auth which is not this)
                // We treat both as an incorrect password
                loginIncorrect: error.httpStatus === 401 || error.httpStatus === 403,
            });
        });
    };

    onPasswordLogin = async (username, phoneCountry, phoneNumber, password) => {
        if (!this.state.serverIsAlive) {
            this.setState({ busy: true });
            // Do a quick liveliness check on the URLs
            let aliveAgain = true;
            try {
                await AutoDiscoveryUtils.validateServerConfigWithStaticUrls(
                    this.props.serverConfig.hsUrl,
                    this.props.serverConfig.isUrl,
                );
                this.setState({ serverIsAlive: true, errorText: "" });
            } catch (e) {
                const componentState = AutoDiscoveryUtils.authComponentStateForError(e);
                this.setState({
                    busy: false,
                    busyLoggingIn: false,
                    ...componentState,
                });
                aliveAgain = !componentState.serverErrorIsFatal;
            }

            // Prevent people from submitting their password when something isn't right.
            if (!aliveAgain) {
                return;
            }
        }

        this.setState({
            busy: true,
            busyLoggingIn: true,
            errorText: null,
            loginIncorrect: false,
        });

        this.loginLogic.loginViaPassword(
            username, phoneCountry, phoneNumber, password,
        ).then((data) => {
            this.setState({ serverIsAlive: true }); // it must be, we logged in.
            this.props.onLoggedIn(data, password);
        }, (error) => {
            if (this.unmounted) {
                return;
            }
            let errorText;

            // Some error strings only apply for logging in
            const usingEmail = username.indexOf("@") > 0;
            if (error.httpStatus === 400 && usingEmail) {
                errorText = _t('This homeserver does not support login using email address.');
            } else if (error.errcode === 'M_RESOURCE_LIMIT_EXCEEDED') {
                const errorTop = messageForResourceLimitError(
                    error.data.limit_type,
                    error.data.admin_contact,
                    {
                        'monthly_active_user': _td(
                            "This homeserver has hit its Monthly Active User limit.",
                        ),
                        'hs_blocked': _td(
                            "This homeserver has been blocked by its administrator.",
                        ),
                        '': _td(
                            "This homeserver has exceeded one of its resource limits.",
                        ),
                    },
                );
                const errorDetail = messageForResourceLimitError(
                    error.data.limit_type,
                    error.data.admin_contact,
                    {
                        '': _td("Please <a>contact your service administrator</a> to continue using this service."),
                    },
                );
                errorText = (
                    <div>
                        <div>{ errorTop }</div>
                        <div className="mx_Login_smallError">{ errorDetail }</div>
                    </div>
                );
            } else if (error.httpStatus === 401 || error.httpStatus === 403) {
                if (error.errcode === 'M_USER_DEACTIVATED') {
                    errorText = _t('This account has been deactivated.');
                } else if (SdkConfig.get("disable_custom_urls")) {
                    errorText = (
                        <div>
                            <div>{ _t('Incorrect username and/or password.') }</div>
                            <div className="mx_Login_smallError">
                                { _t(
                                    'Please note you are logging into the %(hs)s server, not matrix.org.',
                                    { hs: this.props.serverConfig.hsName },
                                ) }
                            </div>
                        </div>
                    );
                } else {
                    errorText = _t('Incorrect username and/or password.');
                }
            } else {
                // other errors, not specific to doing a password login
                errorText = this.errorTextFromError(error);
            }

            this.setState({
                busy: false,
                busyLoggingIn: false,
                errorText: errorText,
                // 401 would be the sensible status code for 'incorrect password'
                // but the login API gives a 403 https://matrix.org/jira/browse/SYN-744
                // mentions this (although the bug is for UI auth which is not this)
                // We treat both as an incorrect password
                loginIncorrect: error.httpStatus === 401 || error.httpStatus === 403,
            });
        });
    };

    onUsernameChanged = username => {
        this.setState({ username: username });
    };

    onUsernameBlur = async username => {
        const doWellknownLookup = username[0] === "@";
        this.setState({
            username: username,
            busy: doWellknownLookup,
            errorText: null,
            canTryLogin: true,
        });
        if (doWellknownLookup) {
            const serverName = username.split(':').slice(1).join(':');
            try {
                const result = await AutoDiscoveryUtils.validateServerName(serverName);
                this.props.onServerConfigChange(result);
                // We'd like to rely on new props coming in via `onServerConfigChange`
                // so that we know the servers have definitely updated before clearing
                // the busy state. In the case of a full MXID that resolves to the same
                // HS as Element's default HS though, there may not be any server change.
                // To avoid this trap, we clear busy here. For cases where the server
                // actually has changed, `initLoginLogic` will be called and manages
                // busy state for its own liveness check.
                this.setState({
                    busy: false,
                });
            } catch (e) {
                logger.error("Problem parsing URL or unhandled error doing .well-known discovery:", e);

                let message = _t("Failed to perform homeserver discovery");
                if (e.translatedMessage) {
                    message = e.translatedMessage;
                }

                let errorText: ReactNode = message;
                let discoveryState = {};
                if (AutoDiscoveryUtils.isLivelinessError(e)) {
                    errorText = this.state.errorText;
                    discoveryState = AutoDiscoveryUtils.authComponentStateForError(e);
                }

                this.setState({
                    busy: false,
                    errorText,
                    ...discoveryState,
                });
            }
        }
    };

    onPhoneCountryChanged = phoneCountry => {
        this.setState({ phoneCountry: phoneCountry });
    };

    onPhoneNumberChanged = phoneNumber => {
        this.setState({
            phoneNumber: phoneNumber,
        });
    };

    onRegisterClick = ev => {
        ev.preventDefault();
        ev.stopPropagation();
        this.props.onRegisterClick();
    };

    onTryRegisterClick = ev => {
        const hasPasswordFlow = this.state.flows?.find(flow => flow.type === "m.login.password");
        const ssoFlow = this.state.flows?.find(flow => flow.type === "m.login.sso" || flow.type === "m.login.cas");
        // If has no password flow but an SSO flow guess that the user wants to register with SSO.
        // TODO: instead hide the Register button if registration is disabled by checking with the server,
        // has no specific errCode currently and uses M_FORBIDDEN.
        if (ssoFlow && !hasPasswordFlow) {
            ev.preventDefault();
            ev.stopPropagation();
            const ssoKind = ssoFlow.type === 'm.login.sso' ? 'sso' : 'cas';
            PlatformPeg.get().startSingleSignOn(this.loginLogic.createTemporaryClient(), ssoKind,
                this.props.fragmentAfterLogin);
        } else {
            // Don't intercept - just go through to the register page
            this.onRegisterClick(ev);
        }
    };

    private async initLoginLogic({ hsUrl, isUrl }: ValidatedServerConfig) {
        let isDefaultServer = false;
        if (this.props.serverConfig.isDefault
            && hsUrl === this.props.serverConfig.hsUrl
            && isUrl === this.props.serverConfig.isUrl) {
            isDefaultServer = true;
        }

        const fallbackHsUrl = isDefaultServer ? this.props.fallbackHsUrl : null;

        const loginLogic = new Login(hsUrl, isUrl, fallbackHsUrl, {
            defaultDeviceDisplayName: this.props.defaultDeviceDisplayName,
        });
        this.loginLogic = loginLogic;

        this.setState({
            busy: true,
            loginIncorrect: false,
        });

        // Do a quick liveliness check on the URLs
        try {
            const { warning } =
                await AutoDiscoveryUtils.validateServerConfigWithStaticUrls(hsUrl, isUrl);
            if (warning) {
                this.setState({
                    ...AutoDiscoveryUtils.authComponentStateForError(warning),
                    errorText: "",
                });
            } else {
                this.setState({
                    serverIsAlive: true,
                    errorText: "",
                });
            }
        } catch (e) {
            this.setState({
                busy: false,
                ...AutoDiscoveryUtils.authComponentStateForError(e),
            });
        }

        loginLogic.getFlows().then((flows) => {
            // look for a flow where we understand all of the steps.
            const supportedFlows = flows.filter(this.isSupportedFlow);

            if (supportedFlows.length > 0) {
                this.setState({
                    flows: supportedFlows,
                });
                return;
            }

            // we got to the end of the list without finding a suitable flow.
            this.setState({
                errorText: _t("This homeserver doesn't offer any login flows which are supported by this client."),
            });
        }, (err) => {
            this.setState({
                errorText: this.errorTextFromError(err),
                loginIncorrect: false,
                canTryLogin: false,
            });
        }).finally(() => {
            this.setState({
                busy: false,
            });
        });
    }

    private isSupportedFlow = (flow: LoginFlow): boolean => {
        // technically the flow can have multiple steps, but no one does this
        // for login and loginLogic doesn't support it so we can ignore it.
        if (!this.stepRendererMap[flow.type]) {
            logger.log("Skipping flow", flow, "due to unsupported login type", flow.type);
            return false;
        }
        return true;
    };

    private errorTextFromError(err: MatrixError): ReactNode {
        let errCode = err.errcode;
        if (!errCode && err.httpStatus) {
            errCode = "HTTP " + err.httpStatus;
        }

        let errorText: ReactNode = _t("There was a problem communicating with the homeserver, " +
            "please try again later.") + (errCode ? " (" + errCode + ")" : "");

        if (err["cors"] === 'rejected') { // browser-request specific error field
            if (window.location.protocol === 'https:' &&
                (this.props.serverConfig.hsUrl.startsWith("http:") ||
                 !this.props.serverConfig.hsUrl.startsWith("http"))
            ) {
                errorText = <span>
                    { _t("Can't connect to homeserver via HTTP when an HTTPS URL is in your browser bar. " +
                        "Either use HTTPS or <a>enable unsafe scripts</a>.", {},
                    {
                        'a': (sub) => {
                            return <a
                                target="_blank"
                                rel="noreferrer noopener"
                                href="https://www.google.com/search?&q=enable%20unsafe%20scripts"
                            >
                                { sub }
                            </a>;
                        },
                    }) }
                </span>;
            } else {
                errorText = <span>
                    { _t("Can't connect to homeserver - please check your connectivity, ensure your " +
                        "<a>homeserver's SSL certificate</a> is trusted, and that a browser extension " +
                        "is not blocking requests.", {},
                    {
                        'a': (sub) =>
                            <a target="_blank" rel="noreferrer noopener" href={this.props.serverConfig.hsUrl}>
                                { sub }
                            </a>,
                    }) }
                </span>;
            }
        }

        return errorText;
    }

    renderLoginComponentForFlows() {
        if (!this.state.flows) return null;

        // this is the ideal order we want to show the flows in
        const order = [
            "web3.signature",
            "m.login.password",
            "m.login.sso",
        ];

        const flows = order.map(type => this.state.flows.find(flow => flow.type === type)).filter(Boolean);
        return <React.Fragment>
            { flows.map(flow => {
                const stepRenderer = this.stepRendererMap[flow.type];
                return <React.Fragment key={flow.type}>{ stepRenderer() }</React.Fragment>;
            }) }
        </React.Fragment>;
    }

    private renderWeb3Step = () => {
        return (
            <div className="mx_SSOButtons">
                { this.renderWeb3Button({}) }
            </div>
        );
    };

    private renderWeb3Button = (props) => {
        const {
            mini= false,
            primary=true,
        } = props;
        const label = _t("Continue with %(provider)s", { provider: "Universal Profile" });

        const onClick = async () => {
            if (!("ethereum" in window)) {
                alert("Please install the Universal Profile extension");
                return;
            }
            const ethereum = window['ethereum'];
            const web3 = new Web3(ethereum);
            await ethereum.request({
                method: "eth_requestAccounts",
            });
            // getting address from which we will sign message
            const addresses = await web3.eth.getAccounts();
            console.log("addresses", addresses);
            const address = addresses[0]?.toLowerCase();

            // generating a token with 1 day of expiration time
            const token = await Web3Token.sign(async (msg) => {
                try {
                    let sig;
                    try {
                        sig = await web3.eth.sign(msg, address);
                    } catch (err) {
                        sig = await web3.eth.personal.sign(msg, address, null);
                    }
                    return typeof sig === "string" ? sig : sig.signature;
                } catch (err) {
                    console.error(">>> catch", err);
                }
            }, "1d");
            this.onTokenLogin(address, token);
        };

        let icon;
        let brandClass;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const brandIcon = "/welcome/images/lukso.svg";
        if (brandIcon) {
            const brandName = "Universal Profile";
            brandClass = `mx_SSOButton_brand_lukso`;
            icon = <img src={brandIcon} height="24" width="24" alt={brandName} />;
        }

        const classes = classNames("mx_SSOButton", {
            [brandClass]: brandClass,
            mx_SSOButton_mini: mini,
            mx_SSOButton_default: false,
            mx_SSOButton_primary: primary,
        });

        if (mini) {
            // TODO fallback icon
            return (
                <AccessibleTooltipButton {...props} title={label} className={classes} onClick={onClick}>
                    { icon }
                </AccessibleTooltipButton>
            );
        }

        return (
            <AccessibleButton {...props} className={classes} onClick={onClick}>
                { icon }
                { label }
            </AccessibleButton>
        );
    };

    private renderPasswordStep = () => {
        return (
            <PasswordLogin
                onSubmit={this.onPasswordLogin}
                username={this.state.username}
                phoneCountry={this.state.phoneCountry}
                phoneNumber={this.state.phoneNumber}
                onUsernameChanged={this.onUsernameChanged}
                onUsernameBlur={this.onUsernameBlur}
                onPhoneCountryChanged={this.onPhoneCountryChanged}
                onPhoneNumberChanged={this.onPhoneNumberChanged}
                onForgotPasswordClick={this.props.onForgotPasswordClick}
                loginIncorrect={this.state.loginIncorrect}
                serverConfig={this.props.serverConfig}
                disableSubmit={this.isBusy()}
                busy={this.props.isSyncing || this.state.busyLoggingIn}
            />
        );
    };

    private renderSsoStep = loginType => {
        const flow = this.state.flows.find(flow => flow.type === "m.login." + loginType) as ISSOFlow;

        return (
            <SSOButtons
                matrixClient={this.loginLogic.createTemporaryClient()}
                flow={flow}
                loginType={loginType}
                fragmentAfterLogin={this.props.fragmentAfterLogin}
                primary={!this.state.flows.find(flow => flow.type === "m.login.password")}
            />
        );
    };

    render() {
        const loader = this.isBusy() && !this.state.busyLoggingIn ?
            <div className="mx_Login_loader"><Spinner /></div> : null;

        const errorText = this.state.errorText;

        let errorTextSection;
        if (errorText) {
            errorTextSection = (
                <div className="mx_Login_error">
                    { errorText }
                </div>
            );
        }

        let serverDeadSection;
        if (!this.state.serverIsAlive) {
            const classes = classNames({
                "mx_Login_error": true,
                "mx_Login_serverError": true,
                "mx_Login_serverErrorNonFatal": !this.state.serverErrorIsFatal,
            });
            serverDeadSection = (
                <div className={classes}>
                    { this.state.serverDeadError }
                </div>
            );
        }

        let footer;
        if (this.props.isSyncing || this.state.busyLoggingIn) {
            footer = <div className="mx_AuthBody_paddedFooter">
                <div className="mx_AuthBody_paddedFooter_title">
                    <InlineSpinner w={20} h={20} />
                    { this.props.isSyncing ? _t("Syncing...") : _t("Signing In...") }
                </div>
                { this.props.isSyncing && <div className="mx_AuthBody_paddedFooter_subtitle">
                    { _t("If you've joined lots of rooms, this might take a while") }
                </div> }
            </div>;
        }

        return (
            <AuthPage>
                <AuthHeader disableLanguageSelector={this.props.isSyncing || this.state.busyLoggingIn} />
                <AuthBody>
                    <h2>
                        { _t('Sign in') }
                        { loader }
                    </h2>
                    { errorTextSection }
                    { serverDeadSection }
                    <ServerPicker
                        serverConfig={this.props.serverConfig}
                        onServerConfigChange={this.props.onServerConfigChange}
                    />
                    { this.renderLoginComponentForFlows() }
                    { footer }
                </AuthBody>
            </AuthPage>
        );
    }
}
