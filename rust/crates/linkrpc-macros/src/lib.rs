//! `#[link_rpc_interface(id = "...")]` — derive a linkrpc interface from a bare trait spec.
//!
//! Applied to a trait whose methods are written **tarpc-style** (no `self`, no `ctx`, inline
//! params), it emits:
//!
//! - the **rewritten server trait** (each method gains `&self` + a `&CallCtx` first arg) that a
//!   provider implements,
//! - a **`<Trait>Server<T>`** adapter implementing [`InterfaceHandler`] (decodes params → calls the
//!   impl → encodes the result),
//! - a typed **`<Trait>Client`** proxy driving a `LinkRpcConnection`,
//! - a **`<trait_snake>::interface()`** builder (+ `ID`) producing the runtime
//!   [`InterfaceDefinition`] whose content hash is the interface identity.
//!
//! This first slice supports request methods (`-> Result<T, E>` or `-> T`) and `#[notification]`
//! methods (`-> ()`); streaming attributes are rejected for now. Doc comments are normative
//! (hashed); `#[annotations(dangerous, read_only, ...)]` attach member annotations.
//!
//! Generated code references `::linkrpc`, `::serde`, `::serde_json`, `::schemars`, and
//! `::async_trait` by absolute path, so the consuming crate must depend on those.

use proc_macro::TokenStream;
use proc_macro2::{Span, TokenStream as TokenStream2};
use quote::{format_ident, quote, ToTokens};
use syn::{
    parse_macro_input, Data, DeriveInput, Fields, FnArg, Ident, ItemTrait, LitInt, LitStr, Meta,
    Pat, ReturnType, TraitItem, TraitItemFn, Type,
};

/// Derive the wire conversion and schema metadata for an application-error enum.
#[proc_macro_derive(ApplicationError, attributes(rpc_error))]
pub fn derive_application_error(item: TokenStream) -> TokenStream {
    let input = parse_macro_input!(item as DeriveInput);
    match expand_application_error(input) {
        Ok(tokens) => tokens.into(),
        Err(error) => error.to_compile_error().into(),
    }
}

fn code_name_for_scope(code: i32) -> String {
    if code < 0 {
        format!("Minus{}", code.unsigned_abs())
    } else {
        code.to_string()
    }
}

fn expand_application_error(input: DeriveInput) -> syn::Result<TokenStream2> {
    let enum_ident = input.ident;
    let Data::Enum(data) = input.data else {
        return Err(syn::Error::new_spanned(
            enum_ident,
            "ApplicationError can only be derived for an enum",
        ));
    };
    let mut variants = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for variant in data.variants {
        let mut code = None;
        let mut message = None;
        for attr in &variant.attrs {
            if !attr.path().is_ident("rpc_error") {
                continue;
            }
            attr.parse_nested_meta(|meta| {
                if meta.path.is_ident("code") {
                    let value: LitInt = meta.value()?.parse()?;
                    code = Some(value.base10_parse::<i32>()?);
                    Ok(())
                } else if meta.path.is_ident("message") {
                    let value: LitStr = meta.value()?.parse()?;
                    message = Some(value.value());
                    Ok(())
                } else {
                    Err(meta.error("expected `code = ...` or `message = \"...\"`"))
                }
            })?;
        }
        let code = code.ok_or_else(|| {
            syn::Error::new_spanned(
                &variant.ident,
                "missing #[rpc_error(code = ..., message = \"...\")]",
            )
        })?;
        let message = message.ok_or_else(|| {
            syn::Error::new_spanned(&variant.ident, "missing rpc_error `message`")
        })?;
        if (-32768..=-32000).contains(&code) || code == -32800 {
            return Err(syn::Error::new_spanned(
                &variant.ident,
                "application error codes must not use protocol-reserved codes (-32768..=-32000 or -32800)",
            ));
        }
        if !seen.insert(code) {
            return Err(syn::Error::new_spanned(
                &variant.ident,
                format!("duplicate application error code {code}"),
            ));
        }
        let payload =
            match variant.fields {
                Fields::Unit => None,
                Fields::Unnamed(fields) if fields.unnamed.len() == 1 => {
                    Some(fields.unnamed.into_iter().next().expect("one field").ty)
                }
                fields => return Err(syn::Error::new_spanned(
                    fields,
                    "application error variants must be unit variants or have one tuple payload",
                )),
            };
        variants.push((variant.ident, code, message, payload));
    }

    let into_arms = variants.iter().map(|(variant, code, message, payload)| {
        if let Some(ty) = payload {
            let scope = format!("Code{}", code_name_for_scope(*code));
            quote! {
                Self::#variant(__data) => {
                    let __raw_schema = match ::serde_json::to_value(::schemars::schema_for!(#ty)) {
                        ::core::result::Result::Ok(__schema) => __schema,
                        ::core::result::Result::Err(__error) => return ::linkrpc::prelude::JsonRpcError::new(
                            ::linkrpc::prelude::error_codes::INTERNAL_ERROR, __error.to_string()),
                    };
                    let (mut __schema, __schemas) =
                        match ::linkrpc::schema::schemars_to_subset_with_components(&__raw_schema) {
                            ::core::result::Result::Ok(__contract) => __contract,
                            ::core::result::Result::Err(__error) => return ::linkrpc::prelude::JsonRpcError::new(
                                ::linkrpc::prelude::error_codes::INTERNAL_ERROR, __error.to_string()),
                        };
                    let mut __errors = ::std::vec![::linkrpc::prelude::ErrorSchema {
                        code: #code,
                        message: #message.to_string(),
                        data: ::core::option::Option::Some(__schema),
                    }];
                    let mut __components = ::linkrpc::prelude::Components {
                        schemas: ::core::option::Option::Some(__schemas),
                    };
                    ::linkrpc::prelude::scope_error_contract(
                        #scope, &mut __errors, &mut __components);
                    __schema = __errors.pop().expect("one error schema").data
                        .expect("payload schema");
                    let __value = match ::serde_json::to_value(__data) {
                        ::core::result::Result::Ok(__value) => __value,
                        ::core::result::Result::Err(__error) => return ::linkrpc::prelude::JsonRpcError::new(
                            ::linkrpc::prelude::error_codes::INTERNAL_ERROR, __error.to_string()),
                    };
                    if !::linkrpc::prelude::validate_json_schema(
                        &__value, &__schema, ::core::option::Option::Some(&__components)
                    ) {
                        return ::linkrpc::prelude::JsonRpcError::new(
                            ::linkrpc::prelude::error_codes::INTERNAL_ERROR,
                            "application error payload does not match its declared schema");
                    }
                    let mut __error = ::linkrpc::prelude::JsonRpcError::new(#code as i64, #message);
                    __error.data = ::core::option::Option::Some(__value);
                    __error
                }
            }
        } else {
            quote!(Self::#variant => ::linkrpc::prelude::JsonRpcError::new(#code as i64, #message))
        }
    });
    let from_arms = variants.iter().map(|(variant, code, message, payload)| {
        if let Some(ty) = payload {
            quote! {
                __code if __code == (#code as i64) && __error.message == #message => {
                    let ::core::option::Option::Some(__data) = __error.data.as_ref() else {
                        return ::core::result::Result::Err(__error);
                    };
                    let (__schema, __schemas) = ::linkrpc::schema::schemars_to_subset_with_components(
                        &::serde_json::to_value(::schemars::schema_for!(#ty))
                            .expect("schema serializes"),
                    ).expect("application error payload is in the linkrpc schema subset");
                    let __components = ::linkrpc::prelude::Components {
                        schemas: ::core::option::Option::Some(__schemas),
                    };
                    if !::linkrpc::prelude::validate_json_schema(
                        __data, &__schema, ::core::option::Option::Some(&__components)
                    ) {
                        return ::core::result::Result::Err(__error);
                    }
                    match ::serde_json::from_value::<#ty>(__data.clone()) {
                        ::core::result::Result::Ok(__data) =>
                            ::core::result::Result::Ok(Self::#variant(__data)),
                        ::core::result::Result::Err(_) =>
                            ::core::result::Result::Err(__error),
                    }
                }
            }
        } else {
            quote! {
                __code if __code == (#code as i64) && __error.message == #message && __error.data.is_none() =>
                    ::core::result::Result::Ok(Self::#variant)
            }
        }
    });
    let schemas = variants.iter().map(|(_, code, message, payload)| {
        let data = if let Some(ty) = payload {
            let scope = format!("Code{}", code_name_for_scope(*code));
            quote! {
                {
                    let (__schema, __schemas) = ::linkrpc::schema::schemars_to_subset_with_components(
                        &::serde_json::to_value(::schemars::schema_for!(#ty))
                            .expect("schema serializes"),
                    ).expect("application error payload is in the linkrpc schema subset");
                    let mut __errors = ::std::vec![::linkrpc::prelude::ErrorSchema {
                        code: #code, message: #message.to_string(),
                        data: ::core::option::Option::Some(__schema),
                    }];
                    let mut __components = ::linkrpc::prelude::Components {
                        schemas: ::core::option::Option::Some(__schemas),
                    };
                    ::linkrpc::prelude::scope_error_contract(
                        #scope, &mut __errors, &mut __components);
                    __errors.pop().expect("one error schema").data
                }
            }
        } else {
            quote!(::core::option::Option::None)
        };
        quote! {
            ::linkrpc::prelude::ErrorSchema {
                code: #code,
                message: #message.to_string(),
                data: #data,
            }
        }
    });
    let error_components = variants.iter().filter_map(|(_, code, message, payload)| {
        payload.as_ref().map(|ty| {
            let scope = format!("Code{}", code_name_for_scope(*code));
            quote! {
                let (__schema, __schemas) = ::linkrpc::schema::schemars_to_subset_with_components(
                    &::serde_json::to_value(::schemars::schema_for!(#ty))
                        .expect("schema serializes"),
                ).expect("application error payload is in the linkrpc schema subset");
                let mut __errors = ::std::vec![::linkrpc::prelude::ErrorSchema {
                    code: #code, message: #message.to_string(),
                    data: ::core::option::Option::Some(__schema),
                }];
                let mut __components = ::linkrpc::prelude::Components {
                    schemas: ::core::option::Option::Some(__schemas),
                };
                ::linkrpc::prelude::scope_error_contract(
                    #scope, &mut __errors, &mut __components);
                for (__name, __schema) in __components.schemas.unwrap_or_default() {
                    match __all.insert(__name.clone(), __schema.clone()) {
                        ::core::option::Option::Some(__previous) if __previous != __schema => {
                            panic!("conflicting application error schema component `{}`", __name)
                        }
                        _ => {}
                    }
                }
            }
        })
    });

    Ok(quote! {
        impl ::linkrpc::prelude::ApplicationError for #enum_ident {
            fn into_rpc_error(self) -> ::linkrpc::prelude::JsonRpcError {
                match self { #(#into_arms),* }
            }

            fn try_from_rpc_error(
                __error: ::linkrpc::prelude::JsonRpcError,
            ) -> ::core::result::Result<Self, ::linkrpc::prelude::JsonRpcError> {
                match __error.code {
                    #(#from_arms,)*
                    _ => ::core::result::Result::Err(__error),
                }
            }

            fn error_schemas() -> ::std::vec::Vec<::linkrpc::prelude::ErrorSchema> {
                ::std::vec![#(#schemas),*]
            }

            fn error_components() -> ::linkrpc::prelude::Components {
                let mut __all = ::std::collections::BTreeMap::new();
                #(#error_components)*
                ::linkrpc::prelude::Components {
                    schemas: (!__all.is_empty()).then_some(__all),
                }
            }
        }
    })
}

/// See crate docs.
#[proc_macro_attribute]
pub fn link_rpc_interface(attr: TokenStream, item: TokenStream) -> TokenStream {
    let id = match parse_id(attr.into()) {
        Ok(id) => id,
        Err(e) => return e.to_compile_error().into(),
    };
    let item = parse_macro_input!(item as ItemTrait);
    match expand(id, item) {
        Ok(ts) => ts.into(),
        Err(e) => e.to_compile_error().into(),
    }
}

/// Parse the `id = "..."` attribute argument.
fn parse_id(attr: TokenStream2) -> syn::Result<String> {
    let meta: Meta = syn::parse2(attr)?;
    match meta {
        Meta::NameValue(nv) if nv.path.is_ident("id") => {
            let lit: LitStr = syn::parse2(nv.value.to_token_stream())?;
            Ok(lit.value())
        }
        other => Err(syn::Error::new_spanned(
            other,
            "expected `#[link_rpc_interface(id = \"...\")]`",
        )),
    }
}

struct MethodModel {
    name: Ident,
    /// Wire member name (the method's identifier as a string).
    wire_name: String,
    is_notification: bool,
    /// `(ident, type)` for each inline parameter, in order.
    params: Vec<(Ident, Type)>,
    /// When set, the single parameter is the params object itself (via `#[params]`); its type is
    /// used directly as the wire param schema instead of synthesizing a wrapper struct.
    passthrough_ty: Option<Type>,
    /// The success/result type for a request (None for notifications).
    result_ty: Option<Type>,
    /// Opt-in application error enum from `#[errors(E)]`.
    error_ty: Option<Type>,
    server_returns_call_error: bool,
    /// Doc-comment text (normative).
    doc: Option<String>,
    /// `#[annotations(...)]` flag idents.
    annotations: Vec<Ident>,
    /// The original return type token stream (for the rewritten trait signature).
    raw_output: ReturnType,
}

fn expand(id: String, item: ItemTrait) -> syn::Result<TokenStream2> {
    let trait_ident = item.ident.clone();
    let vis = item.vis.clone();
    let trait_doc = extract_doc(&item.attrs);

    if !item.generics.params.is_empty() {
        return Err(syn::Error::new_spanned(
            &item.generics,
            "#[link_rpc_interface] does not support generic traits yet",
        ));
    }

    let mut methods = Vec::new();
    for it in &item.items {
        match it {
            TraitItem::Fn(f) => methods.push(parse_method(f)?),
            other => {
                return Err(syn::Error::new_spanned(
                    other,
                    "#[link_rpc_interface] traits may only contain methods",
                ))
            }
        }
    }

    let ctx_ty = quote!(::linkrpc::prelude::CallCtx);

    // ── rewritten server trait ────────────────────────────────────────────────
    let trait_methods = methods.iter().map(|m| {
        let name = &m.name;
        let args = m.params.iter().map(|(id, ty)| quote!(#id: #ty));
        let output = &m.raw_output;
        let doc = m.doc.as_ref().map(|d| quote!(#[doc = #d]));
        quote! {
            #doc
            async fn #name(&self, ctx: &#ctx_ty, #(#args),*) #output;
        }
    });
    let rewritten_trait = quote! {
        #[::async_trait::async_trait]
        #vis trait #trait_ident: ::core::marker::Send + ::core::marker::Sync {
            #(#trait_methods)*
        }
    };

    // ── per-method param structs ──────────────────────────────────────────────
    let param_structs = methods.iter().map(|m| param_struct(&trait_ident, m));

    // ── interface() builder module ────────────────────────────────────────────
    let module_ident = format_ident!("{}", to_snake_case(&trait_ident.to_string()));
    let member_exprs = methods.iter().map(|m| member_expr(&trait_ident, m));
    let iface_desc = match &trait_doc {
        Some(d) => quote!(info = info.with_description(#d);),
        None => quote!(),
    };
    let interface_mod = quote! {
        #vis mod #module_ident {
            #[allow(unused_imports)]
            use super::*;

            /// The interface id (the `id` half of `id@hash`).
            pub const ID: &str = #id;

            fn subset<T: ::schemars::JsonSchema>() -> ::linkrpc::prelude::JsonValue {
                ::linkrpc::schema::schemars_to_subset(
                    &::serde_json::to_value(::schemars::schema_for!(T)).expect("schema serializes"),
                )
                .expect("type is in the linkrpc schema subset")
            }

            /// Build the runtime interface definition (its content hash is the identity).
            pub fn interface() -> ::linkrpc::prelude::InterfaceDefinition {
                let mut info = ::linkrpc::prelude::InterfaceInfo::new(ID);
                #iface_desc
                let members: ::std::vec::Vec<(::std::string::String, ::linkrpc::prelude::Member)> = ::std::vec![
                    #(#member_exprs),*
                ];
                ::linkrpc::prelude::InterfaceDefinition::new(info, members)
            }
        }
    };

    // ── server adapter ────────────────────────────────────────────────────────
    let server_ident = format_ident!("{}Server", trait_ident);
    let request_arms = methods.iter().filter(|m| !m.is_notification).map(|m| {
        let wire = &m.wire_name;
        let params_ty = params_ty(&trait_ident, m);
        let name = &m.name;
        let call_args = if m.passthrough_ty.is_some() {
            vec![quote!(__p)]
        } else {
            m.params.iter().map(|(id, _)| quote!(__p.#id)).collect()
        };
        let map_error = if m.server_returns_call_error {
            quote!(.map_err(::linkrpc::prelude::CallError::into_rpc_error)?)
        } else if m.error_ty.is_some() {
            quote!(.map_err(::linkrpc::prelude::ApplicationError::into_rpc_error)?)
        } else {
            quote!(.map_err(::core::convert::Into::into)?)
        };
        quote! {
            #wire => {
                let __p: #params_ty = ::serde_json::from_value(params).map_err(|e| {
                    ::linkrpc::prelude::JsonRpcError::new(
                        ::linkrpc::prelude::error_codes::INVALID_PARAMS, e.to_string())
                })?;
                let __r = self.0.#name(&ctx, #(#call_args),*).await #map_error;
                ::serde_json::to_value(__r).map_err(|e| {
                    ::linkrpc::prelude::JsonRpcError::new(
                        ::linkrpc::prelude::error_codes::INTERNAL_ERROR, e.to_string())
                })
            }
        }
    });
    let notification_arms = methods.iter().filter(|m| m.is_notification).map(|m| {
        let wire = &m.wire_name;
        let params_ty = params_ty(&trait_ident, m);
        let name = &m.name;
        let call_args = if m.passthrough_ty.is_some() {
            vec![quote!(__p)]
        } else {
            m.params.iter().map(|(id, _)| quote!(__p.#id)).collect()
        };
        quote! {
            #wire => {
                if let ::core::result::Result::Ok(__p) =
                    ::serde_json::from_value::<#params_ty>(params)
                {
                    self.0.#name(&ctx, #(#call_args),*).await;
                }
            }
        }
    });
    let server = quote! {
        /// Server adapter wrapping an implementation as an `InterfaceHandler`.
        #vis struct #server_ident<T>(pub ::std::sync::Arc<T>);

        impl<T> #server_ident<T> {
            pub fn new(inner: ::std::sync::Arc<T>) -> Self {
                #server_ident(inner)
            }
        }

        impl<T> ::linkrpc::prelude::ServiceExport for #server_ident<T>
        where
            T: #trait_ident + 'static,
        {
            fn interface() -> ::linkrpc::prelude::InterfaceDefinition {
                #module_ident::interface()
            }
        }

        #[::async_trait::async_trait]
        impl<T> ::linkrpc::prelude::InterfaceHandler for #server_ident<T>
        where
            T: #trait_ident + 'static,
        {
            async fn handle_request(
                &self,
                member: &str,
                params: ::linkrpc::prelude::JsonValue,
                ctx: ::linkrpc::prelude::CallCtx,
            ) -> ::core::result::Result<::linkrpc::prelude::JsonValue, ::linkrpc::prelude::JsonRpcError> {
                match member {
                    #(#request_arms)*
                    _ => ::core::result::Result::Err(::linkrpc::prelude::JsonRpcError::new(
                        ::linkrpc::prelude::error_codes::METHOD_NOT_FOUND, member)),
                }
            }

            async fn handle_notification(
                &self,
                member: &str,
                params: ::linkrpc::prelude::JsonValue,
                ctx: ::linkrpc::prelude::CallCtx,
            ) {
                let _ = &ctx;
                match member {
                    #(#notification_arms)*
                    _ => {}
                }
            }
        }
    };

    // ── client proxy ──────────────────────────────────────────────────────────
    let client_ident = format_ident!("{}Client", trait_ident);
    let client_methods = methods
        .iter()
        .map(|m| client_method(&trait_ident, &module_ident, m));
    let client = quote! {
        /// Typed client proxy over a `LinkRpcConnection`.
        #[derive(::core::clone::Clone)]
        #vis struct #client_ident {
            conn: ::linkrpc::prelude::LinkRpcConnection,
            service_id: ::core::option::Option<::std::string::String>,
        }

        impl #client_ident {
            /// Address the root service on `conn`.
            pub fn new(conn: ::linkrpc::prelude::LinkRpcConnection) -> Self {
                #client_ident { conn, service_id: ::core::option::Option::None }
            }

            /// Address a specific service id on `conn`.
            pub fn with_service(
                conn: ::linkrpc::prelude::LinkRpcConnection,
                service_id: impl ::core::convert::Into<::std::string::String>,
            ) -> Self {
                #client_ident {
                    conn,
                    service_id: ::core::option::Option::Some(service_id.into()),
                }
            }

            #(#client_methods)*
        }
    };

    Ok(quote! {
        #rewritten_trait
        #(#param_structs)*
        #interface_mod
        #server
        #client
    })
}

fn parse_method(f: &TraitItemFn) -> syn::Result<MethodModel> {
    let sig = &f.sig;
    if sig.asyncness.is_none() {
        return Err(syn::Error::new_spanned(
            sig.fn_token,
            "interface methods must be `async fn`",
        ));
    }
    for attr in &f.attrs {
        if attr.path().is_ident("incoming_stream") || attr.path().is_ident("outgoing_stream") {
            return Err(syn::Error::new_spanned(
                attr,
                "streaming methods are not supported yet",
            ));
        }
    }

    let is_notification = f.attrs.iter().any(|a| a.path().is_ident("notification"));
    let doc = extract_doc(&f.attrs);
    let annotations = extract_annotations(&f.attrs)?;

    let mut params = Vec::new();
    let mut passthrough_ty = None;
    for input in &sig.inputs {
        match input {
            FnArg::Receiver(r) => {
                return Err(syn::Error::new_spanned(
                    r,
                    "interface methods are bare specs: do not write `self` (it is injected)",
                ))
            }
            FnArg::Typed(pt) => {
                let ident = match &*pt.pat {
                    Pat::Ident(p) => p.ident.clone(),
                    other => {
                        return Err(syn::Error::new_spanned(
                            other,
                            "interface parameters must be plain identifiers",
                        ))
                    }
                };
                if pt.attrs.iter().any(|a| a.path().is_ident("params")) {
                    passthrough_ty = Some((*pt.ty).clone());
                }
                params.push((ident, (*pt.ty).clone()));
            }
        }
    }

    if passthrough_ty.is_some() && params.len() != 1 {
        return Err(syn::Error::new_spanned(
            &sig.inputs,
            "#[params] requires the method to take exactly one parameter (the whole params object)",
        ));
    }

    let (result_ty, return_error_ty) = parse_output(&sig.output, is_notification)?;
    let error_ty = extract_errors(&f.attrs)?;
    if is_notification && error_ty.is_some() {
        return Err(syn::Error::new_spanned(
            &f.sig,
            "#[errors(...)] is not valid on notifications",
        ));
    }
    let mut server_returns_call_error = false;
    if let Some(declared) = &error_ty {
        let Some(actual) = &return_error_ty else {
            return Err(syn::Error::new_spanned(
                &f.sig.output,
                "#[errors(E)] requires a `Result<T, E>` return type",
            ));
        };
        let matches_direct =
            declared.to_token_stream().to_string() == actual.to_token_stream().to_string();
        let matches_wrapped = call_error_arg(actual)
            .map(|inner| {
                inner.to_token_stream().to_string() == declared.to_token_stream().to_string()
            })
            .unwrap_or(false);
        if !matches_direct && !matches_wrapped {
            return Err(syn::Error::new_spanned(
                &f.sig.output,
                "#[errors(E)] must name the error type in `Result<T, E>`",
            ));
        }
        server_returns_call_error = matches_wrapped;
    }

    Ok(MethodModel {
        name: sig.ident.clone(),
        wire_name: sig.ident.to_string(),
        is_notification,
        params,
        passthrough_ty,
        result_ty,
        error_ty,
        server_returns_call_error,
        doc,
        annotations,
        raw_output: rewritten_output(&sig.output, is_notification),
    })
}

/// Extract `(result_ty, error_ty)` from the return type.
fn parse_output(
    output: &ReturnType,
    is_notification: bool,
) -> syn::Result<(Option<Type>, Option<Type>)> {
    if is_notification {
        if let ReturnType::Type(_, ty) = output {
            if !is_unit(ty) {
                return Err(syn::Error::new_spanned(
                    ty,
                    "#[notification] methods must return `()`",
                ));
            }
        }
        return Ok((None, None));
    }
    match output {
        ReturnType::Default => Err(syn::Error::new(
            Span::call_site(),
            "request methods must return a value (e.g. `-> Result<T, E>`)",
        )),
        ReturnType::Type(_, ty) => {
            if let Some((ok, err)) = result_args(ty) {
                Ok((Some(ok), err))
            } else {
                Ok((Some((**ty).clone()), None))
            }
        }
    }
}

/// The signature output used in the rewritten trait (unchanged for requests; `()` for notifications).
fn rewritten_output(output: &ReturnType, is_notification: bool) -> ReturnType {
    if is_notification {
        ReturnType::Default
    } else {
        output.clone()
    }
}

/// If `ty` is `Result<T, E>` (or `Result<T>`), return `(T, Some(E)?)`.
fn result_args(ty: &Type) -> Option<(Type, Option<Type>)> {
    let Type::Path(tp) = ty else { return None };
    let seg = tp.path.segments.last()?;
    if seg.ident != "Result" {
        return None;
    }

    let syn::PathArguments::AngleBracketed(args) = &seg.arguments else {
        return None;
    };
    let mut tys = args.args.iter().filter_map(|a| match a {
        syn::GenericArgument::Type(t) => Some(t.clone()),
        _ => None,
    });
    let ok = tys.next()?;
    let err = tys.next();
    Some((ok, err))
}

fn call_error_arg(ty: &Type) -> Option<&Type> {
    let Type::Path(path) = ty else { return None };
    let segment = path.path.segments.last()?;
    if segment.ident != "CallError" {
        return None;
    }
    let syn::PathArguments::AngleBracketed(args) = &segment.arguments else {
        return None;
    };
    args.args.iter().find_map(|arg| match arg {
        syn::GenericArgument::Type(ty) => Some(ty),
        _ => None,
    })
}

fn is_unit(ty: &Type) -> bool {
    matches!(ty, Type::Tuple(t) if t.elems.is_empty())
}

fn param_struct_ident(trait_ident: &Ident, method: &Ident) -> Ident {
    format_ident!("__linkrpc_{}_{}_Params", trait_ident, method)
}

/// The type used as the wire params object: the `#[params]` type directly, else the synthesized
/// wrapper struct.
fn params_ty(trait_ident: &Ident, m: &MethodModel) -> TokenStream2 {
    match &m.passthrough_ty {
        Some(ty) => quote!(#ty),
        None => {
            let pstruct = param_struct_ident(trait_ident, &m.name);
            quote!(#pstruct)
        }
    }
}

fn param_struct(trait_ident: &Ident, m: &MethodModel) -> TokenStream2 {
    if m.passthrough_ty.is_some() {
        return quote!();
    }
    let pstruct = param_struct_ident(trait_ident, &m.name);
    let fields = m.params.iter().map(|(id, ty)| quote!(#id: #ty));
    quote! {
        #[derive(::serde::Serialize, ::serde::Deserialize, ::schemars::JsonSchema)]
        #[serde(rename_all = "camelCase")]
        #[allow(non_camel_case_types, non_snake_case, dead_code)]
        struct #pstruct {
            #(#fields,)*
        }
    }
}

fn member_expr(trait_ident: &Ident, m: &MethodModel) -> TokenStream2 {
    let wire = &m.wire_name;
    let params_ty = params_ty(trait_ident, m);
    let docs = member_docs(m);
    if m.is_notification {
        quote! {
            (#wire.to_string(), ::linkrpc::prelude::Member::Notification(
                ::linkrpc::prelude::NotificationMember {
                    params_schema: subset::<#params_ty>(),
                    docs: #docs,
                }))
        }
    } else {
        let result_ty = m.result_ty.as_ref().expect("request has result type");
        let errors = match &m.error_ty {
            Some(error_ty) => quote! {
                {
                    let mut __errors =
                        <#error_ty as ::linkrpc::prelude::ApplicationError>::error_schemas();
                    let mut __components =
                        <#error_ty as ::linkrpc::prelude::ApplicationError>::error_components();
                    ::linkrpc::prelude::scope_error_contract(
                        #wire, &mut __errors, &mut __components);
                    ::core::option::Option::Some(__errors)
                }
            },
            None => quote!(::core::option::Option::None),
        };
        let error_components = match &m.error_ty {
            Some(error_ty) => quote! {
                {
                    let mut __errors =
                        <#error_ty as ::linkrpc::prelude::ApplicationError>::error_schemas();
                    let mut __components =
                        <#error_ty as ::linkrpc::prelude::ApplicationError>::error_components();
                    ::linkrpc::prelude::scope_error_contract(
                        #wire, &mut __errors, &mut __components);
                    ::core::option::Option::Some(__components)
                }
            },
            None => quote!(::core::option::Option::None),
        };
        quote! {
            (#wire.to_string(), ::linkrpc::prelude::Member::Request(::std::boxed::Box::new(
                ::linkrpc::prelude::RequestMember {
                    params_schema: subset::<#params_ty>(),
                    result_schema: subset::<#result_ty>(),
                    client_stream_schema: ::core::option::Option::None,
                    server_stream_schema: ::core::option::Option::None,
                    errors: #errors,
                    error_components: #error_components,
                    docs: #docs,
                })))
        }
    }
}

fn member_docs(m: &MethodModel) -> TokenStream2 {
    let desc = match &m.doc {
        Some(d) => quote!(::core::option::Option::Some(#d.to_string())),
        None => quote!(::core::option::Option::None),
    };
    let annotations = if m.annotations.is_empty() {
        quote!(::core::option::Option::None)
    } else {
        let setters = m
            .annotations
            .iter()
            .map(|a| quote!(__a.#a = ::core::option::Option::Some(true);));
        quote!({
            let mut __a = ::linkrpc::prelude::MemberAnnotations::default();
            #(#setters)*
            ::core::option::Option::Some(__a)
        })
    };
    quote! {
        ::linkrpc::prelude::MemberDocs {
            description: #desc,
            comment: ::core::option::Option::None,
            annotations: #annotations,
        }
    }
}

fn client_method(trait_ident: &Ident, module: &Ident, m: &MethodModel) -> TokenStream2 {
    let name = &m.name;
    let wire = &m.wire_name;
    let args = m.params.iter().map(|(id, ty)| quote!(#id: #ty));
    let doc = m.doc.as_ref().map(|d| quote!(#[doc = #d]));

    let serialization_error = if m.error_ty.is_some() {
        quote! {
            ::linkrpc::prelude::CallError::Local(
                ::linkrpc::prelude::JsonRpcError::new(
                    ::linkrpc::prelude::error_codes::INTERNAL_ERROR, e.to_string())
            )
        }
    } else {
        quote! {
            ::linkrpc::prelude::JsonRpcError::new(
                ::linkrpc::prelude::error_codes::INTERNAL_ERROR, e.to_string())
        }
    };
    let build_params = if m.passthrough_ty.is_some() {
        let arg = &m.params[0].0;
        quote! {
            let __params = ::serde_json::to_value(#arg).map_err(|e| {
                #serialization_error
            })?;
        }
    } else {
        let pstruct = param_struct_ident(trait_ident, &m.name);
        let field_idents = m.params.iter().map(|(id, _)| id).collect::<Vec<_>>();
        quote! {
            let __params = ::serde_json::to_value(#pstruct { #(#field_idents),* }).map_err(|e| {
                #serialization_error
            })?;
        }
    };

    if m.is_notification {
        quote! {
            #doc
            pub async fn #name(&self, #(#args),*)
                -> ::core::result::Result<(), ::linkrpc::prelude::JsonRpcError>
            {
                #build_params
                self.conn.notify_member(
                    self.service_id.as_deref(), #module::ID, #wire, __params).await
            }
        }
    } else {
        let result_ty = m.result_ty.as_ref().expect("request has result type");
        let error_ty = m.error_ty.as_ref();
        let return_ty = match error_ty {
            Some(error_ty) => quote!(::linkrpc::prelude::CallError<#error_ty>),
            None => quote!(::linkrpc::prelude::JsonRpcError),
        };
        let call = match error_ty {
            Some(error_ty) => quote! {
                let __v = self.conn.call_member_detailed(
                    self.service_id.as_deref(), #module::ID, #wire, __params).await
                    .map_err(::linkrpc::prelude::CallError::<#error_ty>::from_call_error)?;
                ::serde_json::from_value(__v).map_err(|e| {
                    ::linkrpc::prelude::CallError::Local(
                        ::linkrpc::prelude::JsonRpcError::new(
                            ::linkrpc::prelude::error_codes::INTERNAL_ERROR, e.to_string())
                    )
                })
            },
            None => quote! {
                let __v = self.conn.call_member(
                    self.service_id.as_deref(), #module::ID, #wire, __params).await?;
                ::serde_json::from_value(__v).map_err(|e| {
                    ::linkrpc::prelude::JsonRpcError::new(
                        ::linkrpc::prelude::error_codes::INTERNAL_ERROR, e.to_string())
                })
            },
        };
        quote! {
            #doc
            pub async fn #name(&self, #(#args),*)
                -> ::core::result::Result<#result_ty, #return_ty>
            {
                #build_params
                #call
            }
        }
    }
}

/// Concatenate `#[doc = "..."]` attributes into a single trimmed string.
fn extract_doc(attrs: &[syn::Attribute]) -> Option<String> {
    let mut lines = Vec::new();
    for attr in attrs {
        if !attr.path().is_ident("doc") {
            continue;
        }
        if let Meta::NameValue(nv) = &attr.meta {
            if let syn::Expr::Lit(syn::ExprLit {
                lit: syn::Lit::Str(s),
                ..
            }) = &nv.value
            {
                lines.push(s.value().trim().to_string());
            }
        }
    }
    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}

/// Collect the flag idents from `#[annotations(a, b, ...)]`.
fn extract_annotations(attrs: &[syn::Attribute]) -> syn::Result<Vec<Ident>> {
    let mut out = Vec::new();
    for attr in attrs {
        if !attr.path().is_ident("annotations") {
            continue;
        }

        attr.parse_nested_meta(|meta| {
            let ident = meta
                .path
                .get_ident()
                .cloned()
                .ok_or_else(|| meta.error("expected an annotation flag identifier"))?;
            out.push(ident);
            Ok(())
        })?;
    }
    Ok(out)
}

fn extract_errors(attrs: &[syn::Attribute]) -> syn::Result<Option<Type>> {
    let mut result = None;
    for attr in attrs {
        if !attr.path().is_ident("errors") {
            continue;
        }
        if result.is_some() {
            return Err(syn::Error::new_spanned(
                attr,
                "duplicate #[errors(...)] attribute",
            ));
        }
        result = Some(attr.parse_args::<Type>()?);
    }
    Ok(result)
}

fn to_snake_case(s: &str) -> String {
    let mut out = String::new();
    for (i, ch) in s.char_indices() {
        if ch.is_uppercase() {
            if i != 0 {
                out.push('_');
            }
            out.extend(ch.to_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}
