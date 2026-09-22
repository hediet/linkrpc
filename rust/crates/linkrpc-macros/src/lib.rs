//! `#[link_rpc_interface(id = "...")]` — derive a linkrpc interface from a bare trait spec.
//!
//! Applied to a trait whose methods are written **tarpc-style** (no `self`, no `ctx`, inline
//! params), it emits:
//!
//! - the **rewritten server trait** (each method gains `&self` + a `&CallCtx` first arg) that a
//!   provider implements,
//! - a **`<Trait>Server<T>`** adapter implementing [`InterfaceHandler`] (decodes params → calls the
//!   impl → encodes the result),
//! - a typed **`<Trait>Client<C = LinkRpcConnection>`** proxy driving `RpcCall`,
//! - a **`<trait_snake>::interface()`** builder (+ `ID`) producing the runtime
//!   [`InterfaceDefinition`] whose content hash is the interface identity.
//!
//! Request methods may declare `#[input_stream(T)]` (caller→provider) and
//! `#[output_stream(T)]` (provider→caller). Doc comments are normative (hashed);
//! `#[annotations(dangerous, read_only, ...)]` attach member annotations.
//!
//! `schema_json = "..."` imports a frozen interface contract (including its hash)
//! instead of deriving schemas. Imported methods use a `#[params]` argument or
//! `#[params(ExistingStruct)]` on the method to pack inline arguments using an
//! existing struct's Serde representation. They may rename their wire member
//! with `#[name("...")]`. `client`, `server`, `module`, `runtime`,
//! and `generate_server` configure names and client-only generation.
//!
//! Generated code references `::linkrpc`, `::serde`, and `::serde_json`.
//! Rust-authored schema derivation additionally requires `::schemars`.

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

fn expand_application_error(input: DeriveInput) -> syn::Result<TokenStream2> {
    let mut schema = None::<syn::Path>;
    let mut method = None::<LitStr>;
    let mut runtime = syn::parse_quote!(::linkrpc);
    let mut display = false;
    for attr in input
        .attrs
        .iter()
        .filter(|attr| attr.path().is_ident("rpc_error"))
    {
        attr.parse_nested_meta(|meta| {
            if meta.path.is_ident("schema") && schema.is_none() {
                schema = Some(meta.value()?.parse()?);
            } else if meta.path.is_ident("method") && method.is_none() {
                method = Some(meta.value()?.parse()?);
            } else if meta.path.is_ident("runtime") {
                runtime = meta.value()?.parse::<LitStr>()?.parse()?;
            } else if meta.path.is_ident("display") {
                display = true;
            } else {
                return Err(meta.error("expected schema, method, runtime, or display"));
            }
            Ok(())
        })?;
    }
    if schema.is_some() != method.is_some() {
        return Err(syn::Error::new_spanned(
            &input.ident,
            "schema and method must be specified together",
        ));
    }
    let imported = schema.zip(method);
    let enum_ident = input.ident;
    let Data::Enum(data) = input.data else {
        return Err(syn::Error::new_spanned(
            enum_ident,
            "ApplicationError can only be derived for an enum",
        ));
    };
    let mut variants = Vec::new();
    let mut helper_variants = Vec::new();
    let mut payload_structs = Vec::new();
    let mut into_arms = Vec::new();
    let mut from_arms = Vec::new();
    let mut display_arms = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for variant in data.variants {
        let mut code = None;
        let mut message = None;
        let mut name = None;
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
                } else if meta.path.is_ident("name") {
                    name = Some(meta.value()?.parse::<LitStr>()?.value());
                    Ok(())
                } else {
                    Err(meta.error("expected code, message, or name"))
                }
            })?;
        }
        let code = code.unwrap_or(1);
        let name = name.unwrap_or_else(|| {
            variant
                .ident
                .to_string()
                .trim_start_matches("r#")
                .to_owned()
        });
        let message = message.ok_or_else(|| {
            syn::Error::new_spanned(&variant.ident, "missing rpc_error `message`")
        })?;
        if (-32768..=-32000).contains(&code) || code == -32800 {
            return Err(syn::Error::new_spanned(
                &variant.ident,
                "application error codes must not use protocol-reserved codes (-32768..=-32000 or -32800)",
            ));
        }
        if name.is_empty() {
            return Err(syn::Error::new_spanned(
                &variant.ident,
                "application error type must not be empty",
            ));
        }
        if !seen.insert(name.clone()) {
            return Err(syn::Error::new_spanned(
                &variant.ident,
                format!("duplicate application error type `{name}`"),
            ));
        }
        let ident = &variant.ident;
        let fields = &variant.fields;
        helper_variants.push(quote! {
            #[serde(rename = #name)]
            #ident #fields
        });
        let (payload, pattern) = match &variant.fields {
            Fields::Unit => (None, quote!()),
            Fields::Unnamed(fields) if fields.unnamed.len() == 1 => (
                Some(fields.unnamed.first().expect("one field").ty.clone()),
                quote!((__data)),
            ),
            Fields::Named(fields) => {
                let payload_ident = format_ident!("__Payload{}", ident);
                if imported.is_none() {
                    payload_structs.push(quote! {
                        #[derive(::schemars::JsonSchema)]
                        #[schemars(rename = #name)]
                        #[allow(dead_code)]
                        struct #payload_ident #fields
                    });
                }
                let names = fields.named.iter().map(|f| &f.ident);
                (
                    Some(syn::parse_quote!(#payload_ident)),
                    quote!({ #(#names),* }),
                )
            }
            fields => return Err(syn::Error::new_spanned(
                fields,
                "application error variants must be unit, named-field, or single-payload variants",
            )),
        };
        into_arms.push(quote!(Self::#ident #pattern => (__Wire::#ident #pattern, #code, #message)));
        from_arms.push(quote!(__Wire::#ident #pattern => Self::#ident #pattern));
        let display_pattern = match fields {
            Fields::Unit => quote!(),
            Fields::Named(_) => quote!({ .. }),
            Fields::Unnamed(_) => quote!((..)),
        };
        display_arms.push(quote!(Self::#ident #display_pattern => f.write_str(#message)));
        variants.push((variant.ident, code, message, payload, name));
    }

    let bindings = variants.iter().map(|(_, code, message, payload, name)| {
        let has_payload = payload.is_some();
        quote!((#name, #code, #message, #has_payload))
    });
    let schemas = variants.iter().map(|(_, code, message, payload, name)| {
        let data = if let Some(ty) = payload {
            let scope = name;
            quote! {
                {
                    let (__schema, __schemas) = ::linkrpc::schema::schemars_to_subset_with_components(
                        &::serde_json::to_value(::schemars::schema_for!(#ty))
                            .expect("schema serializes"),
                    ).expect("application error payload is in the linkrpc schema subset");
                    let mut __errors = ::std::vec![::linkrpc::prelude::ErrorSchema {
                        code: #code, message: #message.to_string(),
                        r#type: ::core::option::Option::Some(#name.to_owned()),
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
                r#type: ::core::option::Option::Some(#name.to_owned()),
                message: #message.to_string(),
                data: #data,
            }
        }
    });
    let error_components = variants
        .iter()
        .filter_map(|(_, code, message, payload, name)| {
            payload.as_ref().map(|ty| {
            let scope = name;
            quote! {
                let (__schema, __schemas) = ::linkrpc::schema::schemars_to_subset_with_components(
                    &::serde_json::to_value(::schemars::schema_for!(#ty))
                        .expect("schema serializes"),
                ).expect("application error payload is in the linkrpc schema subset");
                let mut __errors = ::std::vec![::linkrpc::prelude::ErrorSchema {
                    code: #code, message: #message.to_string(),
                    r#type: ::core::option::Option::Some(#name.to_owned()),
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

    let schemas_body = if let Some((schema, method)) = &imported {
        quote! {
            #schema().methods.get(#method).expect("declared error method")
                .errors.clone().expect("declared application errors")
        }
    } else {
        quote!(::std::vec![#(#schemas),*])
    };
    let components_body = if let Some((schema, _)) = &imported {
        quote!(#schema().components.clone().unwrap_or(::linkrpc::prelude::Components { schemas: None }))
    } else {
        quote! {
            let mut __all = ::std::collections::BTreeMap::new();
            #(#error_components)*
            ::linkrpc::prelude::Components {
                schemas: (!__all.is_empty()).then_some(__all),
            }
        }
    };
    let display_impl = display.then(|| {
        quote! {
            impl ::std::fmt::Display for #enum_ident {
                fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
                    match self { #(#display_arms),* }
                }
            }
        }
    });
    with_runtime(
        quote! {
            #display_impl
            const _: () = {
            #[derive(::serde::Serialize, ::serde::Deserialize)]
            #[serde(tag = "type", content = "data", deny_unknown_fields)]
            enum __Wire { #(#helper_variants),* }
            #(#payload_structs)*
            impl ::linkrpc::prelude::ApplicationError for #enum_ident {
                fn into_rpc_error(self) -> ::linkrpc::prelude::JsonRpcError {
                    let (__wire, __code, __message) = match self { #(#into_arms),* };
                    let __tagged = match ::serde_json::to_value(__wire) {
                        Ok(value) => value,
                        Err(error) => return ::linkrpc::prelude::JsonRpcError::new(
                            ::linkrpc::prelude::error_codes::INTERNAL_ERROR, error.to_string()),
                    };
                    ::linkrpc::application_error::encode_application_error(
                        __tagged, __code, __message, &Self::error_schemas(), &Self::error_components())
                }

                fn try_from_rpc_error(
                    __error: ::linkrpc::prelude::JsonRpcError,
                ) -> ::core::result::Result<Self, ::linkrpc::prelude::JsonRpcError> {
                    let Some(__tagged) = ::linkrpc::application_error::decode_application_error(
                        &__error, &[#(#bindings),*], &Self::error_schemas(), &Self::error_components())
                    else { return Err(__error); };
                    let Ok(__wire) = ::serde_json::from_value::<__Wire>(__tagged)
                    else { return Err(__error); };
                    Ok(match __wire { #(#from_arms),* })
                }
                fn error_schemas() -> ::std::vec::Vec<::linkrpc::prelude::ErrorSchema> {
                    #schemas_body
                }

                fn error_components() -> ::linkrpc::prelude::Components {
                    #components_body
                }
            }
            };
        },
        &runtime,
    )
}

/// See crate docs.
#[proc_macro_attribute]
pub fn link_rpc_interface(attr: TokenStream, item: TokenStream) -> TokenStream {
    let options = match parse_options(attr.into()) {
        Ok(options) => options,
        Err(e) => return e.to_compile_error().into(),
    };
    let item = parse_macro_input!(item as ItemTrait);
    match expand(options, item) {
        Ok(ts) => ts.into(),
        Err(e) => e.to_compile_error().into(),
    }
}

struct InterfaceOptions {
    id: String,
    inline_schemas: bool,
    schema_json: Option<LitStr>,
    client: Option<Ident>,
    server: Option<Ident>,
    module: Option<Ident>,
    generate_server: bool,
    runtime: syn::Path,
}

fn parse_options(attr: TokenStream2) -> syn::Result<InterfaceOptions> {
    let args = syn::parse::Parser::parse2(
        syn::punctuated::Punctuated::<Meta, syn::Token![,]>::parse_terminated,
        attr,
    )?;
    let mut id = None;
    let mut inline_schemas = None;
    let mut schema_json = None;
    let mut client = None;
    let mut server = None;
    let mut module = None;
    let mut generate_server = None;
    let mut runtime = None;
    for arg in args {
        match arg {
            Meta::NameValue(nv) if nv.path.is_ident("id") && id.is_none() => {
                let lit: LitStr = syn::parse2(nv.value.to_token_stream())?;
                id = Some(lit.value());
            }
            Meta::NameValue(nv) if nv.path.is_ident("schema") && inline_schemas.is_none() => {
                let lit: LitStr = syn::parse2(nv.value.to_token_stream())?;
                inline_schemas = Some(match lit.value().as_str() {
                    "inline" => true,
                    "shared" => false,
                    _ => {
                        return Err(syn::Error::new_spanned(
                            lit,
                            "expected \"inline\" or \"shared\"",
                        ))
                    }
                });
            }
            Meta::NameValue(nv) if nv.path.is_ident("schema_json") && schema_json.is_none() => {
                schema_json = Some(syn::parse2::<LitStr>(nv.value.to_token_stream())?);
            }
            Meta::NameValue(nv) if nv.path.is_ident("client") && client.is_none() => {
                let lit: LitStr = syn::parse2(nv.value.to_token_stream())?;
                client = Some(lit.parse::<Ident>()?);
            }
            Meta::NameValue(nv) if nv.path.is_ident("server") && server.is_none() => {
                let lit: LitStr = syn::parse2(nv.value.to_token_stream())?;
                server = Some(lit.parse::<Ident>()?);
            }
            Meta::NameValue(nv) if nv.path.is_ident("module") && module.is_none() => {
                let lit: LitStr = syn::parse2(nv.value.to_token_stream())?;
                module = Some(lit.parse::<Ident>()?);
            }
            Meta::NameValue(nv)
                if nv.path.is_ident("generate_server") && generate_server.is_none() =>
            {
                generate_server =
                    Some(syn::parse2::<syn::LitBool>(nv.value.to_token_stream())?.value);
            }
            Meta::NameValue(nv) if nv.path.is_ident("runtime") && runtime.is_none() => {
                let lit: LitStr = syn::parse2(nv.value.to_token_stream())?;
                runtime = Some(lit.parse::<syn::Path>()?);
            }
            other => {
                return Err(syn::Error::new_spanned(
                    other,
                    "unknown or duplicate link_rpc_interface option",
                ))
            }
        }
    }
    if let Some(json) = &schema_json {
        if inline_schemas.is_some() {
            return Err(syn::Error::new_spanned(
                json,
                "`schema` and `schema_json` are mutually exclusive",
            ));
        }
        let schema = parse_schema_json(json)?;
        let schema_id = schema
            .get("id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                syn::Error::new_spanned(json, "schema_json must contain an interface id")
            })?;
        if id.as_deref().is_some_and(|id| id != schema_id) {
            return Err(syn::Error::new_spanned(
                json,
                "interface id does not match schema_json",
            ));
        }
        id = Some(schema_id.to_string());
    }
    Ok(InterfaceOptions {
        id: id.ok_or_else(|| syn::Error::new(Span::call_site(), "missing interface id"))?,
        inline_schemas: inline_schemas.unwrap_or(false),
        schema_json,
        client,
        server,
        module,
        generate_server: generate_server.unwrap_or(true),
        runtime: runtime.unwrap_or_else(|| syn::parse_quote!(::linkrpc)),
    })
}

fn parse_schema_json(json: &LitStr) -> syn::Result<serde_json::Value> {
    serde_json::from_str(&json.value())
        .map_err(|error| syn::Error::new_spanned(json, format!("invalid schema_json: {error}")))
}

fn with_runtime(tokens: TokenStream2, runtime: &syn::Path) -> syn::Result<TokenStream2> {
    struct RuntimePath<'a>(&'a syn::Path);
    impl syn::visit_mut::VisitMut for RuntimePath<'_> {
        fn visit_path_mut(&mut self, path: &mut syn::Path) {
            syn::visit_mut::visit_path_mut(self, path);
            if path.leading_colon.is_some()
                && path
                    .segments
                    .first()
                    .is_some_and(|segment| segment.ident == "linkrpc")
            {
                let rest = path.segments.iter().skip(1).cloned().collect::<Vec<_>>();
                *path = self.0.clone();
                path.segments.extend(rest);
            }
        }
    }
    let mut file = syn::parse2::<syn::File>(tokens)?;
    syn::visit_mut::VisitMut::visit_file_mut(&mut RuntimePath(runtime), &mut file);
    Ok(file.into_token_stream())
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
    /// Existing struct used to pack inline arguments without re-deriving its wire shape.
    inline_params_ty: Option<syn::TypePath>,
    /// The success/result type for a request (None for notifications).
    result_ty: Option<Type>,
    /// Application error enum inferred from the request's return type.
    error_ty: Option<Type>,
    server_returns_call_error: bool,
    /// Caller→provider payload type from `#[input_stream(T)]`.
    input_stream_ty: Option<Type>,
    /// Provider→caller payload type from `#[output_stream(T)]`.
    output_stream_ty: Option<Type>,
    /// Doc-comment text (normative).
    doc: Option<String>,
    /// `#[annotations(...)]` flag idents.
    annotations: Vec<Ident>,
    /// The original return type token stream (for the rewritten trait signature).
    raw_output: ReturnType,
    fallible_notification: bool,
    server_notification: bool,
    default_body: Option<syn::Block>,
}

fn expand(options: InterfaceOptions, item: ItemTrait) -> syn::Result<TokenStream2> {
    let id = &options.id;
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
    if let Some(json) = &options.schema_json {
        let schema = parse_schema_json(json)?;
        let declared = schema
            .get("methods")
            .and_then(serde_json::Value::as_object)
            .ok_or_else(|| syn::Error::new_spanned(json, "schema_json must contain methods"))?;
        let mut names = std::collections::BTreeSet::new();
        for method in &methods {
            if !names.insert(&method.wire_name) {
                return Err(syn::Error::new_spanned(
                    &method.name,
                    "duplicate wire method name",
                ));
            }
            let wire = declared.get(&method.wire_name).ok_or_else(|| {
                syn::Error::new_spanned(&method.name, "method is absent from schema_json")
            })?;
            let notification = wire.get("result").is_none() || method.server_notification;
            if method.is_notification != notification
                || method.input_stream_ty.is_some() != wire.get("clientStream").is_some()
                || method.output_stream_ty.is_some() != wire.get("serverStream").is_some()
            {
                return Err(syn::Error::new_spanned(
                    &method.name,
                    "method kind or streams do not match schema_json",
                ));
            }
            let has_errors = wire
                .get("errors")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|errors| !errors.is_empty());
            if method.error_ty.is_some() != has_errors {
                return Err(syn::Error::new_spanned(
                    &method.name,
                    "Result error type does not match schema_json application errors",
                ));
            }
            if method.passthrough_ty.is_none() && method.inline_params_ty.is_none() {
                return Err(syn::Error::new_spanned(
                    &method.name,
                    "schema_json methods require a #[params] parameter or #[params(Type)] method",
                ));
            }
        }
        if names.len() != declared.len() {
            return Err(syn::Error::new_spanned(
                json,
                "trait must declare every schema_json method",
            ));
        }
    }

    let ctx_ty = quote!(::linkrpc::prelude::CallCtx);

    // ── rewritten server trait ────────────────────────────────────────────────
    let trait_methods = methods.iter().map(|m| {
        let name = &m.name;
        let args = m.params.iter().map(|(id, ty)| quote!(#id: #ty));
        let receiver = m
            .input_stream_ty
            .as_ref()
            .map(|ty| quote!(stream_receiver: ::linkrpc::prelude::StreamReceiver<#ty>));
        let sender = m
            .output_stream_ty
            .as_ref()
            .map(|ty| quote!(stream_sender: ::linkrpc::prelude::StreamSender<#ty>));
        let stream_args = [receiver, sender].into_iter().flatten();
        let output = &m.raw_output;
        let doc = m.doc.as_ref().map(|d| quote!(#[doc = #d]));
        let body = m
            .default_body
            .as_ref()
            .map(|body| quote!(#body))
            .unwrap_or_else(|| quote!(;));
        quote! {
            #doc
            async fn #name(&self, ctx: &#ctx_ty, #(#args,)* #(#stream_args),*) #output #body
        }
    });
    let rewritten_trait = quote! {
        #[::linkrpc::prelude::async_trait]
        #vis trait #trait_ident: ::core::marker::Send + ::core::marker::Sync {
            #(#trait_methods)*
        }
    };

    // ── per-method param structs ──────────────────────────────────────────────
    let param_structs = methods.iter().map(|m| param_struct(&trait_ident, m));

    // ── interface() builder module ────────────────────────────────────────────
    let module_ident = options
        .module
        .clone()
        .unwrap_or_else(|| format_ident!("{}", to_snake_case(&trait_ident.to_string())));
    let member_exprs = methods
        .iter()
        .map(|m| member_expr(&trait_ident, m, options.inline_schemas));
    let schema_types = methods
        .iter()
        .flat_map(|m| {
            m.params
                .iter()
                .map(|(_, ty)| ty)
                .chain(m.result_ty.iter())
                .chain(m.input_stream_ty.iter())
                .chain(m.output_stream_ty.iter())
        })
        .collect::<Vec<_>>();
    let schema_registrations = schema_types.iter().map(|ty| {
        quote! {
            __schemas.register::<#ty>()
                .expect("linkrpc schema roots have distinct schema ids");
        }
    });
    let validation_schema_registrations = schema_types.iter().map(|ty| {
        quote! {
            __schemas.register::<#ty>()
                .expect("linkrpc schema roots have distinct schema ids");
        }
    });
    let iface_desc = match &trait_doc {
        Some(d) => quote!(info = info.with_description(#d);),
        None => quote!(),
    };
    let schema_setup = if options.inline_schemas {
        quote!()
    } else {
        quote! {
            let mut __schemas = ::linkrpc::schema::InterfaceSchemaCollector::new();
            #(#schema_registrations)*
            __schemas.initialize().expect("linkrpc schema roots initialize");
        }
    };
    let components = if options.inline_schemas {
        quote!(::core::option::Option::None)
    } else {
        quote!(__schemas
            .components()
            .expect("type is in the linkrpc schema subset"))
    };
    let inline_schema = options.inline_schemas.then(|| {
        quote! {
            fn inline_schema<T: ::schemars::JsonSchema>() -> ::linkrpc::prelude::JsonValue {
                ::linkrpc::schema::schemars_to_subset(
                    &::serde_json::to_value(::schemars::schema_for!(T)).expect("schema serializes"),
                ).expect("inline interface schemas must be non-recursive and in the linkrpc subset")
            }
        }
    });
    let interface_mod = if let Some(json) = &options.schema_json {
        quote! {
            #vis mod #module_ident {
                pub const ID: &str = #id;
                pub const SCHEMA_JSON: &str = #json;

                pub fn schema() -> &'static ::linkrpc::prelude::LinkRpcInterfaceSchema {
                    static SCHEMA: ::std::sync::OnceLock<::linkrpc::prelude::LinkRpcInterfaceSchema> =
                        ::std::sync::OnceLock::new();
                    SCHEMA.get_or_init(|| ::serde_json::from_str(SCHEMA_JSON)
                        .expect("invalid imported interface schema"))
                }

                pub fn interface() -> ::linkrpc::prelude::InterfaceDefinition {
                    ::linkrpc::prelude::InterfaceDefinition::from_schema(schema().clone())
                }

                pub(super) fn stream_schema(member: &str, input: bool)
                    -> ::linkrpc::prelude::JsonValue
                {
                    let schema = schema();
                    let method = schema.methods.get(member).expect("declared method");
                    let root = if input { method.client_stream.as_ref() } else { method.server_stream.as_ref() }
                        .expect("declared stream");
                    let mut document = ::serde_json::json!({ "allOf": [root] });
                    if let ::core::option::Option::Some(components) = &schema.components {
                        document["components"] = ::serde_json::to_value(components)
                            .expect("interface components serialize");
                    }
                    document
                }
            }
        }
    } else {
        quote! {
            #vis mod #module_ident {
                #[allow(unused_imports)]
                use super::*;

                /// The interface id (the `id` half of `id@hash`).
                pub const ID: &str = #id;
                #inline_schema

                pub(super) fn validation_schema<T: ::schemars::JsonSchema>()
                    -> ::linkrpc::prelude::JsonValue
                {
                    let mut __schemas = ::linkrpc::schema::InterfaceSchemaCollector::new();
                    #(#validation_schema_registrations)*
                    __schemas.initialize().expect("linkrpc schema roots initialize");
                    let __root = __schemas.root_schema::<T>()
                        .expect("registered stream schema is in the linkrpc schema subset");
                    match __schemas.components().expect("stream schema components are valid") {
                        ::core::option::Option::Some(__components) => ::serde_json::json!({
                            "allOf": [__root],
                            "components": __components,
                        }),
                        ::core::option::Option::None => __root,
                    }
                }

                /// Build the runtime interface definition (its content hash is the identity).
                pub fn interface() -> ::linkrpc::prelude::InterfaceDefinition {
                    let mut info = ::linkrpc::prelude::InterfaceInfo::new(ID);
                    #iface_desc
                    #schema_setup
                    let members: ::std::vec::Vec<(::std::string::String, ::linkrpc::prelude::Member)> = ::std::vec![
                        #(#member_exprs),*
                    ];
                    let components = #components;
                    ::linkrpc::prelude::InterfaceDefinition::new_with_components(
                        info, members, components)
                }
            }
        }
    };

    // ── server adapter ────────────────────────────────────────────────────────
    let server_ident = options
        .server
        .clone()
        .unwrap_or_else(|| format_ident!("{}Server", trait_ident));
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
        let receiver = m.input_stream_ty.as_ref().map(|ty| {
            let schema =
                stream_schema_expr(&module_ident, m, ty, true, options.schema_json.is_some());
            quote! {
                let __stream_receiver = ctx.stream_receiver::<#ty>(#schema)?;
            }
        });
        let sender = m.output_stream_ty.as_ref().map(|ty| {
            quote! {
                let __stream_sender = ctx.stream_sender::<#ty>()?;
            }
        });
        let stream_args = [
            m.input_stream_ty
                .as_ref()
                .map(|_| quote!(__stream_receiver)),
            m.output_stream_ty.as_ref().map(|_| quote!(__stream_sender)),
        ]
        .into_iter()
        .flatten();
        quote! {
            #wire => {
                let __p: #params_ty = ::serde_json::from_value(params).map_err(|e| {
                    ::linkrpc::prelude::JsonRpcError::new(
                        ::linkrpc::prelude::error_codes::INVALID_PARAMS, e.to_string())
                })?;
                #receiver
                #sender
                let __r = self.0.#name(&ctx, #(#call_args,)* #(#stream_args),*).await
                    #map_error;
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
        let check_result = m.fallible_notification.then(|| quote!(?));
        quote! {
            #wire => {
                let __p: #params_ty = ::serde_json::from_value(params).map_err(|e|
                    ::linkrpc::prelude::JsonRpcError::new(
                        ::linkrpc::prelude::error_codes::INVALID_PARAMS, e.to_string()))?;
                self.0.#name(&ctx, #(#call_args),*).await #check_result;
                ::core::result::Result::Ok(true)
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

            pub fn interface() -> ::linkrpc::prelude::InterfaceDefinition {
                #module_ident::interface()
            }
        }

        impl<T: #trait_ident + 'static> #server_ident<T> {
            pub async fn dispatch_notification(
                &self, member: &str, params: ::linkrpc::prelude::JsonValue,
            ) -> ::core::result::Result<bool, ::linkrpc::prelude::JsonRpcError> {
                self.dispatch_notification_with_ctx(
                    member, params, ::linkrpc::prelude::CallCtx::default()).await
            }

            async fn dispatch_notification_with_ctx(
                &self, member: &str, params: ::linkrpc::prelude::JsonValue,
                ctx: ::linkrpc::prelude::CallCtx,
            ) -> ::core::result::Result<bool, ::linkrpc::prelude::JsonRpcError> {
                let _ = (&params, &ctx);
                match member {
                    #(#notification_arms)*
                    _ => ::core::result::Result::Ok(false),
                }
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

        #[::linkrpc::prelude::async_trait]
        impl<T> ::linkrpc::prelude::InterfaceHandler for #server_ident<T>
        where
            T: #trait_ident + 'static,
        {
            async fn dispatch_notification(
                &self,
                member: &str,
                params: ::linkrpc::prelude::JsonValue,
                ctx: ::linkrpc::prelude::CallCtx,
            ) -> ::core::result::Result<bool, ::linkrpc::prelude::JsonRpcError> {
                self.dispatch_notification_with_ctx(member, params, ctx).await
            }

            async fn handle_request(
                &self,
                member: &str,
                params: ::linkrpc::prelude::JsonValue,
                ctx: ::linkrpc::prelude::CallCtx,
            ) -> ::core::result::Result<::linkrpc::prelude::JsonValue, ::linkrpc::prelude::JsonRpcError> {
                let _ = (&params, &ctx);
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
                if let ::core::result::Result::Err(error) =
                    self.dispatch_notification_with_ctx(member, params, ctx).await
                {
                    ::std::eprintln!("linkrpc notification `{}` failed ({}): {}", member, error.code, error.message);
                }
            }
        }
    };

    // ── client proxy ──────────────────────────────────────────────────────────
    let client_ident = options
        .client
        .clone()
        .unwrap_or_else(|| format_ident!("{}Client", trait_ident));
    let provider_binding = options.generate_server.then(|| quote! {
        impl<T: #trait_ident + 'static> ::linkrpc::binding::InterfaceProvider<#client_ident> for #server_ident<T> {}
    });
    let client_methods = methods
        .iter()
        .map(|m| client_method(&trait_ident, &module_ident, m, &options));
    let has_streams = methods
        .iter()
        .any(|m| m.input_stream_ty.is_some() || m.output_stream_ty.is_some());
    let client = quote! {
        /// Typed client proxy over a `LinkRpcConnection`.
        #[derive(::core::clone::Clone)]
        #vis struct #client_ident<C = ::linkrpc::prelude::LinkRpcConnection> {
            conn: C,
            prefix: ::std::string::String,
        }

        impl ::linkrpc::binding::InterfaceContract for #client_ident {
            type Client<C: ::linkrpc::prelude::RpcCall> = #client_ident<C>;

            fn has_streams() -> bool {
                #has_streams
            }

            fn interface() -> ::linkrpc::prelude::InterfaceDefinition {
                #module_ident::interface()
            }

            fn client<C: ::linkrpc::prelude::RpcCall>(caller: C, prefix: ::std::string::String) -> Self::Client<C> {
                #client_ident::with_prefix(caller, prefix)
            }
        }

        impl<C: ::linkrpc::prelude::RpcCall> #client_ident<C> {
            pub const INTERFACE_ID: &'static str = #module_ident::ID;
            /// Address the root service on `conn`.
            pub fn new(conn: C) -> Self {
                Self::with_prefix(conn, ::std::format!("{}::", Self::INTERFACE_ID))
            }

            /// Address a specific service id on `conn`.
            pub fn with_service(
                conn: C,
                service_id: impl ::core::convert::Into<::std::string::String>,
            ) -> Self {
                let service_id = service_id.into();
                if service_id.is_empty() {
                    Self::new(conn)
                } else {
                    Self::with_prefix(conn, ::std::format!("{}::{}::", service_id, Self::INTERFACE_ID))
                }
            }

            pub fn root(conn: C) -> Self {
                Self::with_prefix(conn, "")
            }

            pub fn with_prefix(conn: C, prefix: impl ::core::convert::Into<::std::string::String>) -> Self {
                Self { conn, prefix: prefix.into() }
            }

            fn method_name(&self, member: &str) -> ::std::string::String {
                ::std::format!("{}{}", self.prefix, member)
            }

            #(#client_methods)*
        }
    };

    let server = options
        .generate_server
        .then(|| quote!(#rewritten_trait #server));
    with_runtime(
        quote! {
            #(#param_structs)*
            #interface_mod
            #server
            #provider_binding
            #client
        },
        &options.runtime,
    )
}

fn parse_method(f: &TraitItemFn) -> syn::Result<MethodModel> {
    let sig = &f.sig;
    if sig.asyncness.is_none() {
        return Err(syn::Error::new_spanned(
            sig.fn_token,
            "interface methods must be `async fn`",
        ));
    }
    let server_notification = f
        .attrs
        .iter()
        .any(|a| a.path().is_ident("server_notification"));
    let is_notification =
        server_notification || f.attrs.iter().any(|a| a.path().is_ident("notification"));
    let mut wire_name = None;
    for attr in f.attrs.iter().filter(|attr| attr.path().is_ident("name")) {
        if wire_name.is_some() {
            return Err(syn::Error::new_spanned(
                attr,
                "duplicate #[name(...)] attribute",
            ));
        }
        wire_name = Some(attr.parse_args::<LitStr>()?.value());
    }
    let fallible_notification = is_notification
        && matches!(&sig.output,
        ReturnType::Type(_, ty) if result_args(ty).is_some());
    let input_stream_ty = parse_stream_attr(&f.attrs, "input_stream")?;
    let output_stream_ty = parse_stream_attr(&f.attrs, "output_stream")?;
    if is_notification && (input_stream_ty.is_some() || output_stream_ty.is_some()) {
        return Err(syn::Error::new_spanned(
            &f.sig,
            "streaming is only supported on request methods, not #[notification] methods",
        ));
    }
    let doc = extract_doc(&f.attrs);
    let annotations = extract_annotations(&f.attrs)?;
    let mut inline_params_ty = None;
    for attr in f.attrs.iter().filter(|attr| attr.path().is_ident("params")) {
        if inline_params_ty.is_some() {
            return Err(syn::Error::new_spanned(
                attr,
                "duplicate #[params(Type)] attribute",
            ));
        }
        inline_params_ty = Some(attr.parse_args::<syn::TypePath>()?);
    }

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
    if passthrough_ty.is_some() && inline_params_ty.is_some() {
        return Err(syn::Error::new_spanned(
            &sig.inputs,
            "#[params(Type)] cannot be combined with a #[params] parameter",
        ));
    }

    let (result_ty, return_error_ty) = parse_output(&sig.output, is_notification)?;
    if let Some(attr) = f.attrs.iter().find(|attr| attr.path().is_ident("errors")) {
        return Err(syn::Error::new_spanned(
            attr,
            "remove #[errors(...)]: application errors are inferred from the Result return type",
        ));
    }
    let wrapped_error_ty = return_error_ty.as_ref().and_then(call_error_arg).cloned();
    let server_returns_call_error = wrapped_error_ty.is_some();
    let error_ty = wrapped_error_ty.or_else(|| {
        return_error_ty.filter(|ty| {
            !matches!(ty, Type::Path(path)
                if path.path.segments.last().is_some_and(|segment| segment.ident == "JsonRpcError"))
        })
    });

    Ok(MethodModel {
        name: sig.ident.clone(),
        wire_name: wire_name
            .unwrap_or_else(|| sig.ident.to_string().trim_start_matches("r#").to_string()),
        is_notification,
        params,
        passthrough_ty,
        inline_params_ty,
        result_ty,
        error_ty,
        server_returns_call_error,
        input_stream_ty,
        output_stream_ty,
        doc,
        annotations,
        raw_output: rewritten_output(&sig.output, is_notification),
        fallible_notification,
        server_notification,
        default_body: f.default.clone(),
    })
}

fn parse_stream_attr(attrs: &[syn::Attribute], name: &str) -> syn::Result<Option<Type>> {
    let mut found = None;
    for attr in attrs.iter().filter(|attr| attr.path().is_ident(name)) {
        if found.is_some() {
            return Err(syn::Error::new_spanned(
                attr,
                format!("duplicate #[{name}(T)] attribute"),
            ));
        }
        found = Some(attr.parse_args::<Type>().map_err(|_| {
            syn::Error::new_spanned(attr, format!("expected #[{name}(StreamItemType)]"))
        })?);
    }
    Ok(found)
}

/// Extract `(result_ty, error_ty)` from the return type.
fn parse_output(
    output: &ReturnType,
    is_notification: bool,
) -> syn::Result<(Option<Type>, Option<Type>)> {
    if is_notification {
        if let ReturnType::Type(_, ty) = output {
            if let Some((ok, Some(err))) = result_args(ty) {
                if is_unit(&ok)
                    && matches!(err, Type::Path(path)
                    if path.path.segments.last().is_some_and(|segment| segment.ident == "JsonRpcError"))
                {
                    return Ok((None, None));
                }
            }
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
    if is_notification && matches!(output, ReturnType::Default) {
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

/// The explicit wire params type, or the synthesized wrapper for inline arguments.
fn params_ty(trait_ident: &Ident, m: &MethodModel) -> TokenStream2 {
    match &m.passthrough_ty {
        Some(ty) => quote!(#ty),
        None => {
            if let Some(ty) = &m.inline_params_ty {
                return quote!(#ty);
            }
            let pstruct = param_struct_ident(trait_ident, &m.name);
            quote!(#pstruct)
        }
    }
}

fn param_struct(trait_ident: &Ident, m: &MethodModel) -> TokenStream2 {
    if m.passthrough_ty.is_some() || m.inline_params_ty.is_some() {
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

fn member_expr(trait_ident: &Ident, m: &MethodModel, inline_schemas: bool) -> TokenStream2 {
    let wire = &m.wire_name;
    let params_ty = params_ty(trait_ident, m);
    let params_schema = if inline_schemas {
        quote!(inline_schema::<#params_ty>())
    } else if m.passthrough_ty.is_some() {
        quote! {
            __schemas.root_schema::<#params_ty>()
                .expect("registered params schema is in the linkrpc schema subset")
        }
    } else {
        quote! {
            __schemas.inline_schema::<#params_ty>()
                .expect("inline params schema is in the linkrpc schema subset")
        }
    };
    let docs = member_docs(m);
    if m.is_notification {
        quote! {
            (#wire.to_string(), ::linkrpc::prelude::Member::Notification(
                ::linkrpc::prelude::NotificationMember {
                    params_schema: #params_schema,
                    docs: #docs,
                }))
        }
    } else {
        let result_ty = m.result_ty.as_ref().expect("request has result type");
        let root_schema = |ty: &Type| {
            if inline_schemas {
                quote!(inline_schema::<#ty>())
            } else {
                quote!(__schemas.root_schema::<#ty>()
                    .expect("registered schema is in the linkrpc schema subset"))
            }
        };
        let result_schema = root_schema(result_ty);
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
        let client_stream_schema = match &m.input_stream_ty {
            Some(ty) => {
                let schema = root_schema(ty);
                quote!(::core::option::Option::Some(#schema))
            }
            None => quote!(::core::option::Option::None),
        };
        let server_stream_schema = match &m.output_stream_ty {
            Some(ty) => {
                let schema = root_schema(ty);
                quote!(::core::option::Option::Some(#schema))
            }
            None => quote!(::core::option::Option::None),
        };
        quote! {
            (#wire.to_string(), ::linkrpc::prelude::Member::Request(::std::boxed::Box::new(
                ::linkrpc::prelude::RequestMember {
                    errors: #errors,
                    error_components: #error_components,
                    params_schema: #params_schema,
                    result_schema: #result_schema,
                    client_stream_schema: #client_stream_schema,
                    server_stream_schema: #server_stream_schema,
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

fn stream_schema_expr(
    module: &Ident,
    method: &MethodModel,
    ty: &Type,
    input: bool,
    imported: bool,
) -> TokenStream2 {
    if imported {
        let wire = &method.wire_name;
        quote!(#module::stream_schema(#wire, #input))
    } else {
        quote!(#module::validation_schema::<#ty>())
    }
}

fn client_method(
    trait_ident: &Ident,
    module: &Ident,
    m: &MethodModel,
    options: &InterfaceOptions,
) -> TokenStream2 {
    let name = &m.name;
    let wire = &m.wire_name;
    let args = m.params.iter().map(|(id, ty)| quote!(#id: #ty));
    let doc = m.doc.as_ref().map(|d| quote!(#[doc = #d]));
    let event_name = m.server_notification.then(|| {
        let name = format_ident!("{}_event_name", name.to_string().trim_start_matches("r#"));
        quote! {
            pub fn #name(&self) -> ::std::string::String {
                self.method_name(#wire)
            }
        }
    });
    if m.server_notification && !options.generate_server {
        return quote!(#event_name);
    }

    let serialization_error = if m.error_ty.is_some() {
        quote! {
            ::linkrpc::prelude::CallError::Generic(::linkrpc::prelude::RpcCallError::Local(
                ::linkrpc::prelude::JsonRpcError::new(
                    ::linkrpc::prelude::error_codes::INTERNAL_ERROR, e.to_string())
            ))
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
        let pstruct = params_ty(trait_ident, m);
        let field_idents = m.params.iter().map(|(id, _)| id).collect::<Vec<_>>();
        quote! {
            let __params = ::serde_json::to_value(#pstruct { #(#field_idents),* }).map_err(|e| {
                #serialization_error
            })?;
        }
    };

    if m.is_notification {
        quote! {
            #event_name
            #doc
            pub async fn #name(&self, #(#args),*)
                -> ::core::result::Result<(), ::linkrpc::prelude::JsonRpcError>
            {
                #build_params
                ::linkrpc::prelude::RpcCall::notify(
                    &self.conn, &self.method_name(#wire), __params).await
            }
        }
    } else {
        let result_ty = m.result_ty.as_ref().expect("request has result type");
        let error_ty = m.error_ty.as_ref();
        let return_ty = match error_ty {
            Some(error_ty) => quote!(::linkrpc::prelude::CallError<#error_ty>),
            None => quote!(::linkrpc::prelude::JsonRpcError),
        };
        if m.input_stream_ty.is_some() || m.output_stream_ty.is_some() {
            let client_ty = m
                .input_stream_ty
                .as_ref()
                .map(|ty| quote!(#ty))
                .unwrap_or_else(|| quote!(::linkrpc::prelude::NoStream));
            let server_ty = m
                .output_stream_ty
                .as_ref()
                .map(|ty| quote!(#ty))
                .unwrap_or_else(|| quote!(::linkrpc::prelude::NoStream));
            let client_schema = m
                .input_stream_ty
                .as_ref()
                .map(|ty| {
                    let schema =
                        stream_schema_expr(module, m, ty, true, options.schema_json.is_some());
                    quote!(::core::option::Option::Some(#schema))
                })
                .unwrap_or_else(|| quote!(::core::option::Option::None));
            let server_schema = m
                .output_stream_ty
                .as_ref()
                .map(|ty| {
                    let schema =
                        stream_schema_expr(module, m, ty, false, options.schema_json.is_some());
                    quote!(::core::option::Option::Some(#schema))
                })
                .unwrap_or_else(|| quote!(::core::option::Option::None));
            let (streaming_ty, start_call, typed_call) = match error_ty {
                Some(error_ty) => (
                    quote!(::linkrpc::prelude::TypedStreamingCall<
                        #result_ty, #client_ty, #server_ty, #error_ty>),
                    quote! {
                        ::linkrpc::prelude::RpcCall::call_stream_detailed(
                            &self.conn, &__method, __params).await
                            .map_err(::linkrpc::prelude::CallError::<#error_ty>::from_call_error)?
                    },
                    quote! {
                        __call.typed_error::<#result_ty, #client_ty, #server_ty, #error_ty>(
                            #client_schema, #server_schema)
                    },
                ),
                None => (
                    quote!(::linkrpc::prelude::StreamingCall<#result_ty, #client_ty, #server_ty>),
                    quote! {
                        ::linkrpc::prelude::RpcCall::call_stream(
                            &self.conn, &__method, __params).await?
                    },
                    quote! {
                        __call.typed::<#result_ty, #client_ty, #server_ty>(
                            #client_schema, #server_schema)
                    },
                ),
            };
            return quote! {
                #doc
                pub async fn #name(&self, #(#args),*)
                    -> ::core::result::Result<#streaming_ty, #return_ty>
                {
                    #build_params
                    let __method = self.method_name(#wire);
                    let __call = #start_call;
                    ::core::result::Result::Ok(#typed_call)
                }
            };
        }
        let call = match error_ty {
            Some(error_ty) => quote! {
                let __v = ::linkrpc::prelude::RpcCall::call_detailed(
                    &self.conn, &self.method_name(#wire), __params).await
                    .map_err(::linkrpc::prelude::CallError::<#error_ty>::from_call_error)?;
                ::serde_json::from_value(__v).map_err(|e| {
                    ::linkrpc::prelude::CallError::Generic(::linkrpc::prelude::RpcCallError::Local(
                        ::linkrpc::prelude::JsonRpcError::new(
                            ::linkrpc::prelude::error_codes::INTERNAL_ERROR, e.to_string())
                    ))
                })
            },
            None => quote! {
                let __v = ::linkrpc::prelude::RpcCall::call(
                    &self.conn, &self.method_name(#wire), __params).await?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imported_schema_options_validate_json_identity_and_layout() {
        for (args, diagnostic) in [
            (quote!(schema_json = "{"), "invalid schema_json"),
            (quote!(schema_json = "{}"), "interface id"),
            (
                quote!(id = "a", schema_json = r#"{"id":"b","methods":{}}"#),
                "does not match",
            ),
            (
                quote!(
                    schema = "inline",
                    schema_json = r#"{"id":"a","methods":{}}"#
                ),
                "mutually exclusive",
            ),
        ] {
            assert!(parse_options(args)
                .err()
                .unwrap()
                .to_string()
                .contains(diagnostic));
        }
    }

    #[test]
    fn imported_traits_must_match_wire_members_and_stream_directions() {
        let json = r#"{"id":"a","hash":"","methods":{"lookup":{"params":true,"result":true,"serverStream":false}}}"#;
        for (item, diagnostic) in [
            (
                quote!(
                    trait Test {}
                ),
                "every schema_json method",
            ),
            (
                quote!(
                    trait Test {
                        async fn missing(#[params] value: String) -> Result<String, JsonRpcError>;
                    }
                ),
                "absent from schema_json",
            ),
            (
                quote!(
                    trait Test {
                        async fn lookup(#[params] value: String) -> Result<String, JsonRpcError>;
                    }
                ),
                "streams do not match",
            ),
            (
                quote!(
                    trait Test {
                        #[output_stream(NoStream)]
                        async fn lookup(value: String) -> Result<String, JsonRpcError>;
                    }
                ),
                "#[params] parameter",
            ),
        ] {
            let options = parse_options(quote!(schema_json = #json)).unwrap();
            let error = expand(options, syn::parse2(item).unwrap()).unwrap_err();
            assert!(error.to_string().contains(diagnostic), "{error}");
        }
    }

    #[test]
    fn schema_layout_defaults_to_shared_and_can_preserve_inline_contracts() {
        assert!(
            !parse_options(quote!(id = "test.shared"))
                .unwrap()
                .inline_schemas
        );
        assert!(
            parse_options(quote!(id = "test.inline", schema = "inline"))
                .unwrap()
                .inline_schemas
        );
        assert!(parse_options(quote!(id = "test.invalid", schema = "unknown")).is_err());
        assert!(parse_options(quote!(
            id = "test.duplicate",
            schema = "inline",
            schema = "shared"
        ))
        .is_err());
    }

    #[test]
    fn infers_direct_and_wrapped_application_errors() {
        let direct: TraitItemFn = parse_quote! {
            async fn lookup() -> std::result::Result<String, errors::LookupError>;
        };
        let direct = parse_method(&direct).unwrap();
        assert_eq!(
            direct.error_ty.unwrap().to_token_stream().to_string(),
            "errors :: LookupError"
        );
        assert!(!direct.server_returns_call_error);

        let wrapped: TraitItemFn = parse_quote! {
            async fn lookup() -> Result<String, linkrpc::prelude::CallError<LookupError>>;
        };
        let wrapped = parse_method(&wrapped).unwrap();
        assert_eq!(
            wrapped.error_ty.unwrap().to_token_stream().to_string(),
            "LookupError"
        );
        assert!(wrapped.server_returns_call_error);
    }

    #[test]
    fn preserves_untyped_errors_and_notifications() {
        let legacy: TraitItemFn = parse_quote! {
            async fn lookup() -> Result<String, linkrpc::prelude::JsonRpcError>;
        };
        assert!(parse_method(&legacy).unwrap().error_ty.is_none());
        let notification: TraitItemFn = parse_quote! {
            #[notification]
            async fn notify();
        };
        assert!(parse_method(&notification).unwrap().error_ty.is_none());
    }

    #[test]
    fn rejects_redundant_error_annotation() {
        let method: TraitItemFn = parse_quote! {
            #[errors(LookupError)]
            async fn lookup() -> Result<String, LookupError>;
        };
        assert!(parse_method(&method)
            .err()
            .unwrap()
            .to_string()
            .contains("inferred from the Result return type"));
    }
    use syn::parse_quote;

    #[test]
    fn parses_duplex_stream_directions() {
        let method: TraitItemFn = parse_quote! {
            #[input_stream(Command)]
            #[output_stream(Event)]
            async fn exchange(value: u32) -> Result<String, Error>;
        };
        let model = parse_method(&method).unwrap();
        assert_eq!(
            model.input_stream_ty.unwrap().to_token_stream().to_string(),
            "Command"
        );
        assert_eq!(
            model
                .output_stream_ty
                .unwrap()
                .to_token_stream()
                .to_string(),
            "Event"
        );
    }

    #[test]
    fn rejects_malformed_and_duplicate_stream_attributes() {
        let malformed: TraitItemFn = parse_quote! {
            #[output_stream]
            async fn watch() -> String;
        };
        assert!(parse_method(&malformed)
            .err()
            .unwrap()
            .to_string()
            .contains("expected #[output_stream(StreamItemType)]"));

        let duplicate: TraitItemFn = parse_quote! {
            #[input_stream(String)]
            #[input_stream(u32)]
            async fn upload() -> String;
        };
        assert!(parse_method(&duplicate)
            .err()
            .unwrap()
            .to_string()
            .contains("duplicate #[input_stream(T)]"));
    }

    #[test]
    fn rejects_streaming_notifications() {
        let method: TraitItemFn = parse_quote! {
            #[notification]
            #[output_stream(String)]
            async fn invalid();
        };
        assert!(parse_method(&method)
            .err()
            .unwrap()
            .to_string()
            .contains("not #[notification]"));
    }

    #[test]
    fn rejects_conflicting_params_attributes() {
        for (method, expected) in [
            (
                parse_quote! {
                    #[params(Payload)]
                    #[params(Payload)]
                    async fn duplicate(value: String) -> String;
                },
                "duplicate #[params(Type)]",
            ),
            (
                parse_quote! {
                    #[params(Payload)]
                    async fn mixed(#[params] value: Payload) -> String;
                },
                "cannot be combined",
            ),
        ] {
            assert!(parse_method(&method)
                .err()
                .unwrap()
                .to_string()
                .contains(expected));
        }
    }
}
