use linkrpc::binding::{BindingAddress, InterfaceBinding};

fn main() {
    let mut target = InterfaceBinding::<()>::new(BindingAddress::Root);
    target.address = BindingAddress::Bare("");
}
