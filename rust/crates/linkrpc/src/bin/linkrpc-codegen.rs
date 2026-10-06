use std::{
    error::Error,
    fs,
    io::{self, Read},
    path::Path,
};

use linkrpc::schema::codegen::{generate_rust_package, GenerateRustPackage};

const HELP: &str = "linkrpc-codegen [--input <file|->] [--output <directory>] [--check]\n\
Reads a Rust generation package (JSON) from stdin by default.\n\
Without --output, writes generated files, hashes and fallback diagnostics as JSON.\n\
--check checks exact directory contents without writing. See rust/docs/codegen-cli.md.";

fn main() {
    if let Err(error) = run() {
        eprintln!("linkrpc-codegen: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let mut input = "-".to_string();
    let mut output = None;
    let mut check = false;
    let mut arguments = std::env::args().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--input" => input = arguments.next().ok_or("--input requires a path")?,
            "--output" => output = Some(arguments.next().ok_or("--output requires a directory")?),
            "--check" => check = true,
            "--help" | "-h" => {
                println!("{HELP}");
                return Ok(());
            }
            "--version" | "-V" => {
                println!("linkrpc-codegen {}", env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
            _ => return Err(format!("unknown argument `{argument}`\n{HELP}").into()),
        }
    }
    if check && output.is_none() {
        return Err("--check requires --output".into());
    }
    let source = if input == "-" {
        let mut source = String::new();
        io::stdin().read_to_string(&mut source)?;
        source
    } else {
        fs::read_to_string(input)?
    };
    let package: GenerateRustPackage = serde_json::from_str(&source)?;
    let generated = generate_rust_package(&package)?;
    if let Some(output) = output {
        let directory = Path::new(&output);
        if directory.exists() {
            for entry in fs::read_dir(directory)? {
                let entry = entry?;
                if !generated
                    .files
                    .contains_key(&entry.file_name().to_string_lossy().into_owned())
                {
                    return Err(
                        format!("obsolete generated output: {}", entry.path().display()).into(),
                    );
                }
            }
        }
        // Verify all files before reporting success, without any writes in check mode.
        if !check {
            fs::create_dir_all(directory)?;
        }
        for (name, code) in &generated.files {
            let path = directory.join(name);
            if check {
                if fs::read_to_string(&path)? != *code {
                    return Err(format!("stale generated output: {}", path.display()).into());
                }
            } else {
                fs::write(path, code)?;
            }
        }
        for warning in generated.unsupported {
            eprintln!("{warning}");
        }
    } else {
        println!("{}", serde_json::to_string(&generated)?);
    }
    Ok(())
}
